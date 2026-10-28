// Replay through the HTTP API, against the real broker (ADR 0005, ADR 0006):
// a Replayed Message goes through the default exchange to the queue that
// dead-lettered it and nowhere else, with the dead-letter and routing headers
// removed; a Replay the broker cannot route fails without disturbing the
// Checkout's channel or the other held Messages.
import type * as amqp from 'amqplib';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  applyAndWait,
  deadLetter,
  deadLetterRoutes,
  drain,
  fixtureQueues,
  purgeQueues,
  readyCount,
  readyMessageIds,
  startApp,
  testProfile,
  uniqueName,
  withChannel,
  type TestApp,
} from './harness.js';

const checkoutPath = (queue: string) => `/api/profiles/local/vhosts/%2F/queues/${encodeURIComponent(queue)}/checkouts`;
const REPLAY = { kind: 'replay' };
const DEAD_LETTER_HEADER = /^(x-death|x-first-death-.*|x-last-death-.*|x-delivery-count|x-acquired-count|CC|BCC)$/;

describe('Replay', () => {
  let app: TestApp;
  const open: string[] = [];
  const tempQueues: string[] = [];

  async function startCheckout(queue: string) {
    const res = await app.post(checkoutPath(queue));
    expect(res.status).toBe(201);
    const checkout = res.body.checkout;
    open.push(checkout.id);
    const handle = (messageId: string): number => checkout.messages.find((m: any) => m.messageId === messageId).handle;
    return { id: checkout.id as string, handle };
  }
  const decide = (id: string, handles: number[], decision: unknown) =>
    app.post(`/api/checkouts/${id}/decisions`, { handles, decision });
  /** Applies and waits for the Apply to end; answers with the Checkout and its outcomes. */
  const apply = (id: string) => applyAndWait(app, `/api/checkouts/${id}/apply`, { confirm: true });

  /** A queue that only this test uses; deleted after the test. */
  async function tempQueue(prefix: string, setup: (ch: amqp.ConfirmChannel, name: string) => Promise<unknown>) {
    const name = uniqueName(prefix);
    tempQueues.push(name);
    await withChannel('/', (ch) => setup(ch, name));
    return name;
  }

  /** Takes every ready Message in `queue`, auto-acked. */
  const take = (queue: string) => withChannel('/', (ch) => drain(ch, queue));

  beforeAll(async () => {
    app = await startApp({ profiles: [testProfile({ name: 'local' })] });
  });
  afterEach(async () => {
    while (open.length) await app.delete(`/api/checkouts/${open.pop()}`);
    while (tempQueues.length) {
      const q = tempQueues.pop()!;
      await withChannel('/', (ch) => ch.deleteQueue(q));
    }
    await purgeQueues('/', fixtureQueues);
  });
  afterAll(async () => {
    await app?.close();
  });

  it.each([
    ['classic', deadLetterRoutes.classic],
    ['quorum', deadLetterRoutes.quorum],
  ] as const)(
    'sends a Message from a %s DLQ only to the queue that dead-lettered it, with cleaned headers and identical body and properties',
    async (_type, route) => {
      // Bound to the origin exchange with the original routing key, and named in the Message's CC header.
      const bystander = await tempQueue('replay.bystander', async (ch, name) => {
        await ch.assertQueue(name);
        await ch.bindQueue(name, route.exchange, route.routingKey);
        await ch.bindQueue(name, route.exchange, name);
      });
      const body = Buffer.from([0x7b, 0x00, 0xff, 0x80, 0x7d]);
      const properties = {
        messageId: 'r-1',
        contentType: 'application/octet-stream',
        contentEncoding: 'identity',
        correlationId: 'corr-1',
        replyTo: 'replies',
        type: 'order.created',
        appId: 'shop',
        timestamp: 1792139557,
        priority: 3,
        headers: { tenant: 'acme', raw: Buffer.from([0, 255]), CC: [bystander] },
      };
      await deadLetter(route, [{ body, options: properties }]);
      // It received the original publish.
      await purgeQueues('/', [bystander]);
      const { id, handle } = await startCheckout(route.dlq);
      await decide(id, [handle('r-1')], REPLAY);

      const applied = await apply(id);

      expect(applied.status).toBe(202);
      expect(applied.body.outcomes).toEqual([
        { handle: handle('r-1'), messageId: 'r-1', decision: REPLAY, status: 'done', reason: null },
      ]);
      expect(await readyCount('/', route.dlq)).toBe(0);
      expect(await readyCount('/', bystander)).toBe(0);
      const arrived = await take(route.workQueue);
      expect(arrived).toHaveLength(1);
      const [m] = arrived;
      expect(m!.content.equals(body)).toBe(true);
      expect(m!.fields).toMatchObject({ exchange: '', routingKey: route.workQueue });
      const { headers, ...arrivedProperties } = m!.properties;
      const { headers: _sent, ...sentProperties } = properties;
      expect(arrivedProperties).toMatchObject({ ...sentProperties, deliveryMode: 2 });
      expect(Object.keys(headers ?? {}).filter((h) => DEAD_LETTER_HEADER.test(h))).toEqual([]);
      expect(headers).toEqual({
        tenant: 'acme',
        raw: Buffer.from([0, 255]),
        'x-volveran-replay-id': expect.stringMatching(/^[0-9a-f-]{36}$/),
        'x-volveran-from': route.dlq,
      });
    },
  );

  it('gives every Replayed Message its own replay id, recorded in its Audit Entry', async () => {
    await deadLetter(deadLetterRoutes.classic, [
      { body: 'a', options: { messageId: 'a' } },
      { body: 'b', options: { messageId: 'b' } },
    ]);
    const { id, handle } = await startCheckout('orders.dlq');
    await decide(id, [handle('a'), handle('b')], REPLAY);

    expect((await apply(id)).status).toBe(202);

    const arrived = await take('orders.work');
    expect(arrived.map((m) => m.properties.messageId)).toEqual(['a', 'b']);
    const ids = arrived.map((m) => m.properties.headers?.['x-volveran-replay-id']);
    expect(new Set(ids).size).toBe(2);
    // The Audit Entry of each Replay names its replay id, and can be found by it.
    for (const m of arrived) {
      const replayId = m.properties.headers?.['x-volveran-replay-id'];
      const { entries } = (await app.get(`/api/audit-entries?replayId=${replayId}`)).body;
      expect(entries).toEqual([expect.objectContaining({ checkoutId: id, messageId: m.properties.messageId, action: 'replay', replayId })]);
    }
  });

  it('records the original headers, not the body, in the Audit Entry', async () => {
    await deadLetter(deadLetterRoutes.quorum, [
      { body: 'secret', options: { messageId: 'p-1', correlationId: 'corr-9', headers: { tenant: 'acme', CC: ['nowhere'] } } },
    ]);
    const { id, handle } = await startCheckout('payments.dlq');
    await decide(id, [handle('p-1')], REPLAY);

    expect((await apply(id)).status).toBe(202);

    const { entries } = (await app.get(`/api/audit-entries?checkoutId=${id}`)).body;
    expect(entries).toEqual([
      expect.objectContaining({
        queue: 'payments.dlq',
        messageId: 'p-1',
        action: 'replay',
        reason: null,
        destination: { exchange: '', routingKey: 'payments.work', queue: 'payments.work' },
        outcome: 'done',
        outcomeReason: null,
      }),
    ]);
    const { entry } = (await app.get(`/api/audit-entries/${entries[0].id}`)).body;
    expect(entry.message.body).toBeNull();
    expect(entry.message.properties).toMatchObject({ messageId: 'p-1', correlationId: 'corr-9' });
    expect(entry.message.headers).toMatchObject({
      tenant: 'acme',
      CC: ['nowhere'],
      'x-death': [expect.objectContaining({ queue: 'payments.work', reason: 'rejected' })],
      'x-first-death-queue': 'payments.work',
    });
  });

  it('fails cleanly when the dead-lettering queue was deleted mid-Checkout, leaving the Checkout channel and held Messages intact', async () => {
    // Dead-letters straight into orders.dlq through the default exchange.
    const doomed = await tempQueue('replay.doomed', (ch, name) =>
      ch.assertQueue(name, { arguments: { 'x-dead-letter-exchange': '', 'x-dead-letter-routing-key': 'orders.dlq' } }),
    );
    await withChannel('/', async (ch) => {
      ch.sendToQueue(doomed, Buffer.from('lost'), { messageId: 'lost' });
      await ch.waitForConfirms();
      const m = await ch.get(doomed);
      if (!m) throw new Error('seeded Message missing');
      ch.nack(m, false, false);
      await ch.checkQueue(doomed);
    });
    await deadLetter(deadLetterRoutes.classic, ['k-1', 'ok', 'd-1', 'k-2'].map((m) => ({ body: m, options: { messageId: m } })));
    // orders.dlq now holds: lost, k-1, ok, d-1, k-2
    const { id, handle } = await startCheckout('orders.dlq');
    await withChannel('/', (ch) => ch.deleteQueue(doomed));
    await decide(id, [handle('lost'), handle('ok')], REPLAY);
    await decide(id, [handle('d-1')], { kind: 'discard', reason: 'after the failure' });

    const applied = await apply(id);

    expect(applied.status).toBe(202);
    const status = Object.fromEntries(applied.body.outcomes.map((o: any) => [o.messageId, [o.status, o.reason]]));
    expect(status).toEqual({
      lost: ['failed', expect.stringContaining(doomed)],
      'k-1': ['kept', null],
      ok: ['done', null],
      'd-1': ['done', null],
      'k-2': ['kept', null],
    });
    // The failed Replay fell back to Keep, in its place; the Checkout channel still acked the later steps.
    expect(await readyMessageIds('/', 'orders.dlq')).toEqual(['lost', 'k-1', 'k-2']);
    expect(await readyMessageIds('/', 'orders.work')).toEqual(['ok']);
    const { entries } = (await app.get(`/api/audit-entries?checkoutId=${id}&action=replay`)).body;
    expect(entries.map((e: any) => [e.messageId, e.outcome])).toEqual(
      expect.arrayContaining([
        ['lost', 'failed'],
        ['ok', 'done'],
      ]),
    );
  });
});
