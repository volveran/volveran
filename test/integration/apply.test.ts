// Apply with Discard through the HTTP API, against the real broker (ADR 0001):
// a Discarded Message is stored durably, then acked; every other Message goes
// back to the queue in order; a Checkout that stops being active mid-Apply
// stops the Apply there. Apply runs in the background (ADR 0009): it answers
// 202 at once, and its progress and outcomes are read from the Checkout.
import type { ChildProcess } from 'node:child_process';
import { rm } from 'node:fs/promises';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  brokerUsers,
  appliedCheckout,
  applyAndWait,
  checkoutConnectionNames,
  closeConnection,
  deadLetter,
  deadLetterRoutes,
  eventually,
  fixtureQueues,
  makeTempDir,
  purgeQueues,
  readyMessageIds,
  seedMessages,
  sleep,
  spawnServer,
  startApp,
  testOperator,
  testProfile,
  waitForReady,
  type TestApp,
} from './harness.js';

const checkoutPath = (queue: string) => `/api/profiles/local/vhosts/%2F/queues/${encodeURIComponent(queue)}/checkouts`;
const discard = (reason = 'duplicate order') => ({ kind: 'discard', reason });
const KEEP = { kind: 'keep' };

type Hook = ((entryId: number) => Promise<void>) | null;

describe('Apply with Discard', () => {
  let app: TestApp;
  let beforeApplyStep: Hook = null;
  const open: string[] = [];

  async function startCheckout(queue: string, on: TestApp = app) {
    const res = await on.post(checkoutPath(queue));
    expect(res.status).toBe(201);
    const checkout = res.body.checkout;
    open.push(checkout.id);
    /** Message handle by message_id. */
    const handle = (messageId: string): number => checkout.messages.find((m: any) => m.messageId === messageId).handle;
    return { checkout, id: checkout.id as string, handle };
  }

  const decide = (id: string, handles: number[], decision: unknown, on: TestApp = app) =>
    on.post(`/api/checkouts/${id}/decisions`, { handles, decision });
  const startApply = (id: string, on: TestApp = app) => on.post(`/api/checkouts/${id}/apply`, { confirm: true });
  /** Applies and waits for the Apply to end; answers with the Checkout and its outcomes. */
  const apply = (id: string, on: TestApp = app) => applyAndWait(on, `/api/checkouts/${id}/apply`, { confirm: true });

  beforeAll(async () => {
    app = await startApp({
      profiles: [testProfile({ name: 'local' })],
      checkoutTestHooks: { beforeApplyStep: async (entryId) => beforeApplyStep?.(entryId) },
    });
  });
  afterEach(async () => {
    beforeApplyStep = null;
    while (open.length) await app.delete(`/api/checkouts/${open.pop()}`);
    await purgeQueues('/', fixtureQueues);
  });
  afterAll(async () => {
    await app?.close();
  });

  it.each(['orders.dlq', 'payments.dlq'])(
    'on %s removes only the Discarded Messages and returns the others in order',
    async (queue) => {
      await seedMessages('/', queue, 5);
      const { id, handle } = await startCheckout(queue);
      await decide(id, [handle(`${queue}-1`), handle(`${queue}-3`)], discard());

      const unconfirmed = await app.post(`/api/checkouts/${id}/apply`, {});
      expect([unconfirmed.status, unconfirmed.body.error.code]).toEqual([400, 'confirmation_required']);

      const applied = await apply(id);

      expect(applied.status).toBe(202);
      expect(applied.body.outcomes).toEqual(
        [0, 1, 2, 3, 4].map((n) => ({
          handle: handle(`${queue}-${n}`),
          messageId: `${queue}-${n}`,
          decision: n % 2 ? discard() : KEEP,
          status: n % 2 ? 'done' : 'kept',
          reason: null,
        })),
      );
      expect(applied.body.checkout).toMatchObject({ status: 'ended', endReason: 'applied', heldCount: 0 });
      expect(applied.body.checkout.lastApply.outcomes).toEqual(applied.body.outcomes);
      await waitForReady('/', queue, 3);
      expect(await readyMessageIds('/', queue)).toEqual([0, 2, 4].map((n) => `${queue}-${n}`));
      // The queue and the Operator are free for the next Checkout.
      await startCheckout(queue);
    },
  );

  it('answers 202 at once and shows the progress of the Apply on the Checkout while it runs', async () => {
    await seedMessages('/', 'orders.dlq', 4);
    const { checkout, id, handle } = await startCheckout('orders.dlq');
    const all: number[] = checkout.messages.map((m: any) => m.handle);
    await decide(id, all.slice(0, 3), discard());
    let steps = 0;
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    // Hold the second step, once the first is done.
    beforeApplyStep = async () => {
      if (++steps === 2) await held;
    };

    const started = await startApply(id);
    try {
      await expectProgress();
    } finally {
      release();
    }
    const ended = await appliedCheckout(app, id);

    expect(ended).toMatchObject({ status: 'ended', endReason: 'applied', heldCount: 0 });

    async function expectProgress() {
      expect(started.status).toBe(202);
      expect(started.body.outcomes).toBeUndefined();
      expect(started.body.checkout).toMatchObject({ status: 'applying', lastApply: null });
      const during = await eventually(async () => {
        const { checkout: c } = (await app.get(`/api/checkouts/${id}`)).body;
        expect(c.applyProgress.done).toBe(1);
        return c;
      });
      expect(during.status).toBe('applying');
      expect(during.applyProgress).toEqual({
        total: 3,
        done: 1,
        failed: 0,
        notAttempted: 0,
        remaining: 2,
        rate: null,
        startedAt: expect.any(String),
        estimatedEndAt: expect.any(String),
        stoppedBy: null,
        phase: 'running',
      });
      expect(Date.parse(during.applyProgress.estimatedEndAt)).toBeGreaterThanOrEqual(
        Date.parse(during.applyProgress.startedAt),
      );
    }
    expect(ended.applyProgress).toMatchObject({ total: 3, done: 3, remaining: 0 });
    expect(ended.lastApply.outcomes).toEqual(
      [0, 1, 2, 3].map((n) => ({
        handle: handle(`orders.dlq-${n}`),
        messageId: `orders.dlq-${n}`,
        decision: n < 3 ? discard() : KEEP,
        status: n < 3 ? 'done' : 'kept',
        reason: null,
      })),
    );
    expect(await readyMessageIds('/', 'orders.dlq')).toEqual(['orders.dlq-3']);
  });

  it('stores a byte-identical copy of each Discarded Message with the reason, the Operator and the broker user', async () => {
    const body = Buffer.from([0x7b, 0x00, 0xff, 0x80, 0x0a, 0x7d]);
    await deadLetter(deadLetterRoutes.quorum, [
      {
        body,
        options: {
          messageId: 'pay-1',
          contentType: 'application/octet-stream',
          correlationId: 'corr-1',
          timestamp: 1792139557,
          headers: { tenant: 'acme', raw: Buffer.from([0, 255]) },
        },
      },
      { body: 'keep me', options: { messageId: 'pay-2' } },
    ]);
    const { id, handle } = await startCheckout('payments.dlq');
    await decide(id, [handle('pay-1')], discard('  card declined twice  '));
    const before = Date.now();

    expect((await apply(id)).status).toBe(202);

    const listed = await app.get(`/api/audit-entries?checkoutId=${id}`);
    expect(listed.status).toBe(200);
    expect(listed.body.entries).toHaveLength(1);
    const [summary] = listed.body.entries;
    expect(summary).toMatchObject({
      operatorId: testOperator,
      operatorName: testOperator,
      brokerUser: brokerUsers.admin.username,
      profile: 'local',
      vhost: '/',
      queue: 'payments.dlq',
      messageId: 'pay-1',
      action: 'discard',
      reason: 'card declined twice',
      destination: null,
      outcome: 'done',
      outcomeReason: null,
      checkoutId: id,
    });
    expect(Date.parse(summary.at)).toBeGreaterThanOrEqual(before - 1000);
    expect(summary.message.body).toBeUndefined(); // listing never carries bodies

    const { entry } = (await app.get(`/api/audit-entries/${summary.id}`)).body;
    expect(Buffer.from(entry.message.body, 'base64').equals(body)).toBe(true);
    expect(entry.message.bodyBytes).toBe(body.length);
    expect(entry.message.properties).toMatchObject({
      messageId: 'pay-1',
      contentType: 'application/octet-stream',
      correlationId: 'corr-1',
      timestamp: 1792139557,
    });
    expect(entry.message.headers).toMatchObject({
      tenant: 'acme',
      raw: { $bytes: Buffer.from([0, 255]).toString('base64') },
      'x-death': [expect.objectContaining({ queue: 'payments.work', reason: 'rejected', exchange: 'payments' })],
    });
    await waitForReady('/', 'payments.dlq', 1);
    expect(await readyMessageIds('/', 'payments.dlq')).toEqual(['pay-2']);
  });

  it('refuses Apply on a Checkout that has ended', async () => {
    await seedMessages('/', 'orders.dlq', 1);
    const { id, handle } = await startCheckout('orders.dlq');
    await decide(id, [handle('orders.dlq-0')], discard());
    await app.delete(`/api/checkouts/${id}`);

    const applied = await apply(id);

    expect([applied.status, applied.body.error.code]).toEqual([409, 'checkout_not_active']);
    expect(await readyMessageIds('/', 'orders.dlq')).toEqual(['orders.dlq-0']);
  });

  it('refuses Apply on a Lost Checkout, saying why it was lost', async () => {
    await seedMessages('/', 'orders.dlq', 2);
    const { id, handle } = await startCheckout('orders.dlq');
    await decide(id, [handle('orders.dlq-0')], discard());
    const names = await eventually(async () => {
      const found = await checkoutConnectionNames('orders.dlq');
      expect(found).toHaveLength(1);
      return found;
    });
    await closeConnection(names[0]!);
    await eventually(async () => expect((await app.get(`/api/checkouts/${id}`)).body.checkout.status).toBe('lost'));

    const applied = await apply(id);

    expect([applied.status, applied.body.error.code]).toEqual([409, 'checkout_not_active']);
    expect(applied.body.error.message).toMatch(/lost.*connection to the broker was closed/);
    expect(await readyMessageIds('/', 'orders.dlq')).toEqual(['orders.dlq-0', 'orders.dlq-1']);
    expect((await app.get(`/api/audit-entries?checkoutId=${id}`)).body.entries).toEqual([]);
  });

  it('keeps the finished Discards and returns every other Message when the connection drops mid-Apply', async () => {
    await seedMessages('/', 'orders.dlq', 8);
    const { checkout, id } = await startCheckout('orders.dlq');
    const all: number[] = checkout.messages.map((m: any) => m.handle);
    await decide(id, all.slice(0, 6), discard());
    const [connection] = await eventually(async () => {
      const found = await checkoutConnectionNames('orders.dlq');
      expect(found).toHaveLength(1);
      return found;
    });
    let steps = 0;
    // Drop the connection once the third Discard is stored, before its ack.
    beforeApplyStep = async () => {
      if (++steps !== 3) return;
      await closeConnection(connection!);
      await eventually(async () => expect((await app.get(`/api/checkouts/${id}`)).body.checkout.status).toBe('lost'));
    };

    const applied = await apply(id);

    expect(applied.status).toBe(202);
    expect(applied.body.checkout.status).toBe('lost');
    expect(applied.body.outcomes.map((o: any) => [o.messageId, o.status])).toEqual([
      ['orders.dlq-0', 'done'],
      ['orders.dlq-1', 'done'],
      ['orders.dlq-2', 'failed'],
      ['orders.dlq-3', 'not-attempted'],
      ['orders.dlq-4', 'not-attempted'],
      ['orders.dlq-5', 'not-attempted'],
      ['orders.dlq-6', 'kept'],
      ['orders.dlq-7', 'kept'],
    ]);
    expect(await readyMessageIds('/', 'orders.dlq')).toEqual([2, 3, 4, 5, 6, 7].map((n) => `orders.dlq-${n}`));
    const { entries } = (await app.get(`/api/audit-entries?checkoutId=${id}`)).body;
    expect(entries.map((e: any) => [e.messageId, e.outcome]).reverse()).toEqual([
      ['orders.dlq-0', 'done'],
      ['orders.dlq-1', 'done'],
      ['orders.dlq-2', 'failed'],
    ]);
  });

  it('does not let a missing heartbeat end the Checkout while Apply runs', async () => {
    const quick = await startApp({
      profiles: [testProfile({ name: 'local' })],
      checkoutTiming: { heartbeatWindowMs: 2_000 },
      checkoutTestHooks: { beforeApplyStep: async (entryId) => beforeApplyStep?.(entryId) },
    });
    try {
      await seedMessages('/', 'orders.dlq', 3);
      const { checkout, id } = await startCheckout('orders.dlq', quick);
      await decide(id, checkout.messages.map((m: any) => m.handle).slice(0, 2), discard(), quick);
      beforeApplyStep = () => sleep(2_500); // the heartbeat window passes during each step
      // The window runs until the Apply starts: a slow setup must not end the Checkout before it.
      expect((await quick.post(`/api/checkouts/${id}/heartbeat`)).body.checkout.status).toBe('active');

      const applied = await apply(id, quick);

      expect(applied.body.outcomes.map((o: any) => o.status)).toEqual(['done', 'done', 'kept']);
      expect(applied.body.checkout).toMatchObject({ status: 'ended', endReason: 'applied' });
      expect(await readyMessageIds('/', 'orders.dlq')).toEqual(['orders.dlq-2']);
    } finally {
      open.length = 0;
      await quick.close();
    }
  });

  it('stops the Apply before its next step at the time limit, returning the rest to the queue in order', async () => {
    const quick = await startApp({
      profiles: [testProfile({ name: 'local' })],
      checkoutTiming: { timeLimitMs: 1_000, heartbeatWindowMs: 1_000 },
      checkoutTestHooks: { beforeApplyStep: async (entryId) => beforeApplyStep?.(entryId) },
    });
    try {
      await seedMessages('/', 'orders.dlq', 4);
      const { checkout, id } = await startCheckout('orders.dlq', quick);
      await decide(id, checkout.messages.map((m: any) => m.handle).slice(0, 3), discard(), quick);
      beforeApplyStep = () => sleep(1_500); // the time limit passes during the first step

      const applied = await apply(id, quick);

      expect(applied.body.outcomes.map((o: any) => [o.messageId, o.status, o.reason])).toEqual([
        ['orders.dlq-0', 'done', null],
        ['orders.dlq-1', 'not-attempted', expect.stringMatching(/time limit.*back in the queue/)],
        ['orders.dlq-2', 'not-attempted', expect.stringMatching(/time limit.*back in the queue/)],
        ['orders.dlq-3', 'kept', null],
      ]);
      expect(applied.body.checkout).toMatchObject({ status: 'ended', endReason: 'time-limit', heldCount: 0 });
      expect(applied.body.checkout.applyProgress).toMatchObject({ total: 3, done: 1, notAttempted: 2, remaining: 0 });
      expect(await readyMessageIds('/', 'orders.dlq')).toEqual(['orders.dlq-1', 'orders.dlq-2', 'orders.dlq-3']);
      expect((await quick.get(`/api/audit-entries?checkoutId=${id}`)).body.entries).toHaveLength(1);
    } finally {
      open.length = 0;
      await quick.close();
    }
  });

  describe('when the process is killed between storing a Discarded Message and acking it', () => {
    let dir: string;
    let child: ChildProcess | undefined;
    afterEach(async () => {
      child?.kill('SIGKILL');
      if (dir) await rm(dir, { recursive: true, force: true });
    });

    /** Runs test/integration/die-before-ack-server.ts; resolves with its URL. */
    async function startChild(dataDir: string): Promise<string> {
      const spawned = await spawnServer({
        script: 'test/integration/die-before-ack-server.ts',
        dir,
        dataDir,
        profiles: [testProfile({ name: 'local', passwordEnv: 'LOCAL_PW' })],
        env: { VOLVERAN_OPERATOR: 'killed-operator', LOCAL_PW: brokerUsers.admin.password },
      });
      child = spawned.child;
      return spawned.url;
    }

    it('leaves the Message in the queue and in the store, never lost', async () => {
      dir = await makeTempDir('killed-apply');
      const dataDir = path.join(dir, 'data');
      await seedMessages('/', 'orders.dlq', 2);
      const url = await startChild(dataDir);
      const post = (urlPath: string, body: unknown) =>
        fetch(url + urlPath, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
      const { checkout } = await (await post(checkoutPath('orders.dlq'), {})).json();
      await post(`/api/checkouts/${checkout.id}/decisions`, { handles: [checkout.messages[0].handle], decision: discard() });
      const exited = new Promise((resolve) => child!.once('exit', resolve));

      await post(`/api/checkouts/${checkout.id}/apply`, { confirm: true }).catch(() => null);
      await exited;

      await eventually(async () =>
        expect((await readyMessageIds('/', 'orders.dlq')).sort()).toEqual(['orders.dlq-0', 'orders.dlq-1']),
      );
      const restarted = await startApp({ profiles: [testProfile({ name: 'local' })], dataDir });
      try {
        const { entries } = (await restarted.get('/api/audit-entries')).body;
        expect(entries.map((e: any) => [e.messageId, e.action, e.outcome, e.operatorName])).toEqual([
          ['orders.dlq-0', 'discard', 'pending', 'killed-operator'],
        ]);
        const { entry } = (await restarted.get(`/api/audit-entries/${entries[0].id}`)).body;
        expect(Buffer.from(entry.message.body, 'base64').toString()).toBe('{"n":0}');
      } finally {
        await restarted.close();
      }
      // Starting a child process (tsx) takes longer than the default.
    }, 60_000);
  });
});
