// Canary Replay through the HTTP API, against the real broker: an Apply that
// starts with a Canary Replays that one Message alone, watches the
// dead-letter exchange for the Watch Window through a queue of its own, and
// waits for the Operator to continue or stop. The Canary's outcome is on the
// Checkout view and on its Audit Entry.
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  appliedCheckout,
  deadLetter,
  deadLetterRoutes,
  eventually,
  fixtureQueues,
  management,
  purgeQueues,
  readyCount,
  readyMessageIds,
  startApp,
  testProfile,
  withChannel,
  type TestApp,
} from './harness.js';

const route = deadLetterRoutes.classic;
const checkoutPath = (profile: string, queue: string) =>
  `/api/profiles/${profile}/vhosts/%2F/queues/${encodeURIComponent(queue)}/checkouts`;
const REPLAY = { kind: 'replay' };
const DISCARD = { kind: 'discard', reason: 'duplicate order' };

/** A work queue dead-lettering through a headers exchange: a Canary from its DLQ cannot be watched. */
const headers = { dlx: 'canary.headers.dlx', work: 'canary.headers.work', dlq: 'canary.headers.dlq' };

describe('Canary Replay', () => {
  let app: TestApp;
  const open: string[] = [];

  async function startCheckout(queue: string = route.dlq, profile = 'local', on: TestApp = app) {
    const res = await on.post(checkoutPath(profile, queue));
    expect(res.status).toBe(201);
    const checkout = res.body.checkout;
    open.push(checkout.id);
    const handle = (messageId: string) => checkout.messages.find((m: any) => m.messageId === messageId).handle as number;
    return { id: checkout.id as string, checkout, handle, handles: checkout.messages.map((m: any) => m.handle) as number[] };
  }
  const decide = (id: string, handles: number[], decision: unknown, on: TestApp = app) =>
    on.post(`/api/checkouts/${id}/decisions`, { handles, decision });
  const view = async (id: string, on: TestApp = app) => (await on.get(`/api/checkouts/${id}`)).body.checkout;
  /** The Checkout once its Apply waits in `phase` (canary_watch or canary_done). */
  const waitingIn = (id: string, phase: string, on: TestApp = app, timeoutMs = 15_000) =>
    eventually(async () => {
      const checkout = await view(id, on);
      if (checkout.applyProgress?.phase !== phase) throw new Error(`Apply is in ${checkout.applyProgress?.phase}, not ${phase}`);
      return checkout;
    }, timeoutMs);
  const outcomesOf = (checkout: any) => checkout.lastApply.outcomes.map((o: any) => [o.messageId, o.status]);
  const auditEntries = async (id: string) => (await app.get(`/api/audit-entries?checkoutId=${id}`)).body.entries as any[];

  /** Dead-letters canary-0 .. canary-<n-1> into orders.dlq only (the other DLQs of the fanout are emptied). */
  async function deadLettered(n: number) {
    await deadLetter(
      route,
      Array.from({ length: n }, (_, i) => ({ body: `order ${i}`, options: { messageId: `canary-${i}` } })),
    );
    await purgeQueues('/', route.dlqs.filter((q) => q !== route.dlq));
  }

  /** The consumer of orders.work takes the next Message and rejects it (dead-letters it again) or acks it. */
  async function consume(how: 'reject' | 'ack') {
    await withChannel('/', async (ch) => {
      const m = await eventually(async () => {
        const got = await ch.get(route.workQueue, { noAck: false });
        if (!got) throw new Error(`nothing in ${route.workQueue} yet`);
        return got;
      });
      if (how === 'reject') ch.nack(m, false, false);
      else ch.ack(m);
      await ch.checkQueue(route.workQueue);
    });
  }

  beforeAll(async () => {
    await withChannel('/', async (ch) => {
      await ch.assertExchange(headers.dlx, 'headers', { durable: true });
      await ch.assertQueue(headers.work, { durable: true, arguments: { 'x-dead-letter-exchange': headers.dlx } });
      await ch.assertQueue(headers.dlq, { durable: true });
      await ch.bindQueue(headers.dlq, headers.dlx, '', { 'x-match': 'any', kind: 'order' });
    });
    app = await startApp({
      profiles: [testProfile({ name: 'local' }), testProfile({ name: 'quick', canary: { watchWindow: '5s' } })],
      checkoutTiming: { timeLimitMs: 120_000 },
    });
  });
  afterEach(async () => {
    while (open.length) await app.delete(`/api/checkouts/${open.pop()}`);
    await purgeQueues('/', [...fixtureQueues, headers.work, headers.dlq]);
  });
  afterAll(async () => {
    await app?.close();
    await withChannel('/', async (ch) => {
      await ch.deleteQueue(headers.work);
      await ch.deleteQueue(headers.dlq);
      await ch.deleteExchange(headers.dlx);
    });
  });

  it('Replays the Canary alone, and a consumer that rejects it leads to died_again with the new reason; watching consumes nothing from the DLQ', async () => {
    await deadLettered(3);
    const { id, handles } = await startCheckout();
    await decide(id, handles, REPLAY);

    const started = await app.post(`/api/checkouts/${id}/apply`, { confirm: true, canary: true });
    expect(started.status).toBe(202);
    const watching = await waitingIn(id, 'canary_watch');

    expect(watching.status).toBe('applying');
    expect(watching.canary).toMatchObject({
      handle: handles[0],
      messageId: 'canary-0',
      status: 'watching',
      deadLetterReason: null,
      auditEntryId: expect.any(Number),
    });
    expect(Date.parse(watching.canary.watchEndsAt) - Date.now()).toBeGreaterThan(20_000);
    // The Canary alone went out; the others are still held.
    expect(watching.heldCount).toBe(2);
    expect(await readyMessageIds('/', route.workQueue)).toEqual(['canary-0']);
    expect(await readyCount('/', route.dlq)).toBe(0);

    await consume('reject');

    const done = await waitingIn(id, 'canary_done');
    expect(done.canary).toMatchObject({ status: 'died_again', deadLetterReason: 'rejected' });
    // The DLQ got its own copy of the Canary: the watch took nothing from it.
    expect(await readyCount('/', route.dlq)).toBe(1);
  });

  it('a consumer that acks the Canary leads to not_dead_lettered after the Watch Window; Continue carries out the rest', async () => {
    await deadLettered(3);
    const { id, handles } = await startCheckout(route.dlq, 'quick');
    await decide(id, handles, REPLAY);

    expect((await app.post(`/api/checkouts/${id}/apply`, { confirm: true, canary: true })).status).toBe(202);
    await waitingIn(id, 'canary_watch');
    await consume('ack');

    const done = await waitingIn(id, 'canary_done', app, 15_000);
    expect(done.canary.status).toBe('not_dead_lettered');
    expect(done.heldCount).toBe(2);

    const continued = await app.post(`/api/checkouts/${id}/apply/continue`);
    expect(continued.status).toBe(200);
    const applied = await appliedCheckout(app, id);
    expect(outcomesOf(applied)).toEqual([
      ['canary-0', 'done'],
      ['canary-1', 'done'],
      ['canary-2', 'done'],
    ]);
    expect(await readyMessageIds('/', route.workQueue)).toEqual(['canary-1', 'canary-2']);
  });

  it('Stop after the Canary returns the rest to the queue in order, not attempted', async () => {
    await deadLettered(4);
    const { id, handle, handles } = await startCheckout();
    await decide(id, handles, REPLAY);

    // The picked Canary goes first; the rest follow in Checkout order.
    expect((await app.post(`/api/checkouts/${id}/apply`, { confirm: true, canary: { handle: handle('canary-2') } })).status).toBe(202);
    await waitingIn(id, 'canary_watch');
    expect(await readyMessageIds('/', route.workQueue)).toEqual(['canary-2']);

    expect((await app.post(`/api/checkouts/${id}/apply/stop`)).status).toBe(200);
    const applied = await appliedCheckout(app, id);
    expect(outcomesOf(applied)).toEqual([
      ['canary-0', 'not-attempted'],
      ['canary-1', 'not-attempted'],
      ['canary-2', 'done'],
      ['canary-3', 'not-attempted'],
    ]);
    expect(await readyMessageIds('/', route.dlq)).toEqual(['canary-0', 'canary-1', 'canary-3']);
    // Nothing to continue once stopped.
    expect((await app.post(`/api/checkouts/${id}/apply/continue`)).status).toBe(409);
  });

  it('continues before the Watch Window ends', async () => {
    await deadLettered(2);
    const { id, handles } = await startCheckout();
    await decide(id, handles, REPLAY);
    expect((await app.post(`/api/checkouts/${id}/apply`, { confirm: true, canary: true })).status).toBe(202);
    await waitingIn(id, 'canary_watch');

    expect((await app.post(`/api/checkouts/${id}/apply/continue`)).status).toBe(200);
    const applied = await appliedCheckout(app, id);
    expect(outcomesOf(applied)).toEqual([
      ['canary-0', 'done'],
      ['canary-1', 'done'],
    ]);
    expect(applied.canary.status).toBe('not_dead_lettered');
  });

  it('refuses a Canary without a Replay (canary_needs_replay), and a picked Canary whose Decision is not Replay', async () => {
    await deadLettered(2);
    const { id, handles } = await startCheckout();
    await decide(id, [handles[0]!], DISCARD);

    const refused = await app.post(`/api/checkouts/${id}/apply`, { confirm: true, canary: true });
    expect(refused.status).toBe(400);
    expect(refused.body.error.code).toBe('canary_needs_replay');

    await decide(id, [handles[1]!], REPLAY);
    const notReplay = await app.post(`/api/checkouts/${id}/apply`, { confirm: true, canary: { handle: handles[0] } });
    expect(notReplay.status).toBe(400);
    expect(notReplay.body.error.code).toBe('invalid_request');
    expect((await view(id)).status).toBe('active');
  });

  it('says beforehand that a Canary from a DLQ fed by a headers dead-letter exchange is unwatched, and reports it so', async () => {
    await withChannel('/', async (ch) => {
      ch.sendToQueue(headers.work, Buffer.from('h'), { messageId: 'headers-0', headers: { kind: 'order' } });
      ch.sendToQueue(headers.work, Buffer.from('h'), { messageId: 'headers-1', headers: { kind: 'order' } });
      await ch.waitForConfirms();
      for (let i = 0; i < 2; i++) {
        const m = await eventually(async () => (await ch.get(headers.work, { noAck: false })) || Promise.reject(new Error('empty')));
        ch.nack(m, false, false);
      }
      await ch.checkQueue(headers.work);
    });
    await eventually(async () => expect(await readyCount('/', headers.dlq)).toBe(2));
    const { id, handles } = await startCheckout(headers.dlq);
    await decide(id, handles, REPLAY);

    const { applyConfirmation } = await view(id);
    expect(applyConfirmation.canary).toEqual({
      watchWindowMs: 30_000,
      candidates: [
        { handle: handles[0], watch: { watchable: false, reason: expect.stringContaining('headers exchange "canary.headers.dlx"') } },
        { handle: handles[1], watch: { watchable: false, reason: expect.any(String) } },
      ],
    });

    expect((await app.post(`/api/checkouts/${id}/apply`, { confirm: true, canary: true })).status).toBe(202);
    const done = await waitingIn(id, 'canary_done');
    expect(done.canary.status).toBe('unwatched');
    expect(done.canary.deadLetterReason).toBeNull();
    expect((await app.post(`/api/checkouts/${id}/apply/continue`)).status).toBe(200);
    expect(outcomesOf(await appliedCheckout(app, id))).toEqual([
      ['headers-0', 'done'],
      ['headers-1', 'done'],
    ]);
  });

  it('shows a watchable Canary in the confirmation, with the Watch Window', async () => {
    await deadLettered(1);
    const { id, handles } = await startCheckout(route.dlq, 'quick');
    await decide(id, handles, REPLAY);
    expect((await view(id)).applyConfirmation.canary).toEqual({
      watchWindowMs: 5_000,
      candidates: [{ handle: handles[0], watch: { watchable: true } }],
    });
  });

  it('marks the Canary\'s Audit Entry with its outcome', async () => {
    await deadLettered(2);
    const { id, handles } = await startCheckout();
    await decide(id, handles, REPLAY);
    expect((await app.post(`/api/checkouts/${id}/apply`, { confirm: true, canary: true })).status).toBe(202);
    await waitingIn(id, 'canary_watch');
    await consume('reject');
    const done = await waitingIn(id, 'canary_done');
    expect((await app.post(`/api/checkouts/${id}/apply/continue`)).status).toBe(200);
    await appliedCheckout(app, id);

    const entries = await auditEntries(id);
    const canaryEntry = entries.find((e) => e.messageId === 'canary-0');
    expect(canaryEntry).toMatchObject({ id: done.canary.auditEntryId, canary: true, canaryOutcome: 'died_again' });
    expect(entries.find((e) => e.messageId === 'canary-1')).toMatchObject({ canary: false, canaryOutcome: null });
  });

  it('the Checkout timing out during the wait reports the rest not attempted, and the watch queue is gone', async () => {
    const short = await startApp({ profiles: [testProfile({ name: 'local' })], checkoutTiming: { timeLimitMs: 8_000 } });
    try {
      await deadLettered(3);
      const { id, handles } = await startCheckout(route.dlq, 'local', short);
      open.pop();
      await decide(id, handles, REPLAY, short);
      expect((await short.post(`/api/checkouts/${id}/apply`, { confirm: true, canary: true })).status).toBe(202);
      await waitingIn(id, 'canary_watch', short);
      await eventually(async () => expect((await management(`/queues/%2F/volveran.canary.${id}`)).status).toBe(200));

      const applied = await appliedCheckout(short, id, 20_000);
      expect(applied.endReason).toBe('time-limit');
      expect(applied.lastApply.outcomes.map((o: any) => [o.messageId, o.status, o.reason])).toEqual([
        ['canary-0', 'done', null],
        ['canary-1', 'not-attempted', expect.stringContaining('time limit')],
        ['canary-2', 'not-attempted', expect.stringContaining('time limit')],
      ]);
      await eventually(async () => expect((await management(`/queues/%2F/volveran.canary.${id}`)).status).toBe(404));
    } finally {
      await short.close();
    }
  }, 40_000);

  it('keeps the heartbeat running while the Apply waits: no heartbeat ends the Checkout and reports the rest not attempted', async () => {
    const quiet = await startApp({
      profiles: [testProfile({ name: 'local' })],
      checkoutTiming: { timeLimitMs: 120_000, heartbeatWindowMs: 3_000 },
    });
    try {
      await deadLettered(2);
      const { id, handles } = await startCheckout(route.dlq, 'local', quiet);
      open.pop();
      await decide(id, handles, REPLAY, quiet);
      expect((await quiet.post(`/api/checkouts/${id}/apply`, { confirm: true, canary: true })).status).toBe(202);
      await waitingIn(id, 'canary_watch', quiet);

      const applied = await appliedCheckout(quiet, id, 20_000);
      expect(applied.endReason).toBe('no-heartbeat');
      expect(applied.lastApply.outcomes.map((o: any) => [o.messageId, o.status])).toEqual([
        ['canary-0', 'done'],
        ['canary-1', 'not-attempted'],
      ]);
      expect(applied.canary.status).toBe('not_dead_lettered');
    } finally {
      await quiet.close();
    }
  }, 40_000);
});
