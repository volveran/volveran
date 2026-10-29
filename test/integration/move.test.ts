// Move through the HTTP API, against the real broker (ADR 0005): a Moved
// Message goes to the queue, or the exchange and routing key, the Operator
// picked, under the same publish and header rules as Replay; a Move the
// broker cannot route fails and falls back to Keep without disturbing the
// Checkout.
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
  seedMessages,
  startApp,
  testProfile,
  uniqueName,
  waitForReady,
  withChannel,
  type TestApp,
} from './harness.js';

const checkoutPath = (queue: string) => `/api/profiles/local/vhosts/%2F/queues/${encodeURIComponent(queue)}/checkouts`;
const DEAD_LETTER_HEADER = /^(x-death|x-first-death-.*|x-last-death-.*|x-delivery-count|x-acquired-count|CC|BCC)$/;
const toQueue = (queue: string) => ({ kind: 'move', destination: { queue } });
const toExchange = (exchange: string, routingKey: string) => ({ kind: 'move', destination: { exchange, routingKey } });

describe('Move', () => {
  let app: TestApp;
  const open: string[] = [];
  const tempQueues: string[] = [];
  const tempExchanges: string[] = [];

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
  /** Takes every ready Message in `queue`, auto-acked. */
  const take = (queue: string) => withChannel('/', (ch) => drain(ch, queue));

  /** A queue that only this test uses; deleted after the test. */
  async function tempQueue(prefix: string, setup: (ch: amqp.ConfirmChannel, name: string) => Promise<unknown> = (ch, name) => ch.assertQueue(name)) {
    const name = uniqueName(prefix);
    tempQueues.push(name);
    await withChannel('/', (ch) => setup(ch, name));
    return name;
  }
  async function tempExchange(prefix: string, type: string) {
    const name = uniqueName(prefix);
    tempExchanges.push(name);
    await withChannel('/', (ch) => ch.assertExchange(name, type));
    return name;
  }

  beforeAll(async () => {
    app = await startApp({ profiles: [testProfile({ name: 'local' })] });
  });
  afterEach(async () => {
    while (open.length) await app.delete(`/api/checkouts/${open.pop()}`);
    while (tempQueues.length) {
      const q = tempQueues.pop()!;
      await withChannel('/', (ch) => ch.deleteQueue(q));
    }
    while (tempExchanges.length) {
      const e = tempExchanges.pop()!;
      await withChannel('/', (ch) => ch.deleteExchange(e));
    }
    await purgeQueues('/', fixtureQueues);
  });
  afterAll(async () => {
    await app?.close();
  });

  it('sends a Message to an existing queue with cleaned headers and identical body and properties, and removes it from the source', async () => {
    const body = Buffer.from([0x7b, 0x00, 0xff, 0x7d]);
    const properties = {
      messageId: 'pay-1',
      contentType: 'application/json',
      correlationId: 'corr-1',
      appId: 'billing',
      priority: 3,
      timestamp: 1792139557,
      headers: { tenant: 'acme', raw: Buffer.from([0, 255]), CC: ['payments.dlq.classic'] },
    };
    await deadLetter(deadLetterRoutes.quorum, [
      { body, options: properties },
      { body: 'stay', options: { messageId: 'pay-2' } },
    ]);
    const { id, handle } = await startCheckout('payments.dlq');
    expect((await decide(id, [handle('pay-1')], toQueue('triage.manual'))).status).toBe(200);
    await purgeQueues('/', ['payments.dlq.classic']);

    const applied = await apply(id);

    expect(applied.status).toBe(202);
    expect(applied.body.outcomes).toHaveLength(2);
    expect(applied.body.outcomes).toEqual(
      expect.arrayContaining([
        { handle: handle('pay-1'), messageId: 'pay-1', decision: toQueue('triage.manual'), status: 'done', reason: null },
        { handle: handle('pay-2'), messageId: 'pay-2', decision: { kind: 'keep' }, status: 'kept', reason: null },
      ]),
    );
    await waitForReady('/', 'payments.dlq', 1);
    expect(await readyMessageIds('/', 'payments.dlq')).toEqual(['pay-2']);
    expect(await readyCount('/', 'payments.dlq.classic')).toBe(0);
    const arrived = await take('triage.manual');
    expect(arrived).toHaveLength(1);
    const m = arrived[0]!;
    expect(m.content.equals(body)).toBe(true);
    expect(m.fields).toMatchObject({ exchange: '', routingKey: 'triage.manual' });
    const { headers, ...arrivedProperties } = m.properties;
    const { headers: _sent, ...sentProperties } = properties;
    expect(arrivedProperties).toMatchObject({ ...sentProperties, deliveryMode: 2 });
    expect(Object.keys(headers ?? {}).filter((h) => DEAD_LETTER_HEADER.test(h))).toEqual([]);
    expect(headers).toEqual({
      tenant: 'acme',
      raw: Buffer.from([0, 255]),
      'x-volveran-replay-id': expect.stringMatching(/^[0-9a-f-]{36}$/),
      'x-volveran-from': 'payments.dlq',
    });
  });
  it('sends a Message to an exchange with the routing key the Operator gave, delivered according to its bindings', async () => {
    const exchange = await tempExchange('move.topic', 'topic');
    const matching = await tempQueue('move.matching', async (ch, name) => {
      await ch.assertQueue(name);
      await ch.bindQueue(name, exchange, 'manual.*');
    });
    const other = await tempQueue('move.other', async (ch, name) => {
      await ch.assertQueue(name);
      await ch.bindQueue(name, exchange, 'auto.*');
    });
    await deadLetter(deadLetterRoutes.classic, [{ body: 'x', options: { messageId: 'o-1', headers: { tenant: 'acme' } } }]);
    const { id, handle } = await startCheckout('orders.dlq');
    const decision = toExchange(exchange, 'manual.review');
    expect((await decide(id, [handle('o-1')], decision)).status).toBe(200);

    const applied = await apply(id);

    expect(applied.body.outcomes).toEqual([{ handle: handle('o-1'), messageId: 'o-1', decision, status: 'done', reason: null }]);
    expect(await readyCount('/', 'orders.dlq')).toBe(0);
    expect(await readyCount('/', other)).toBe(0);
    const [m, ...rest] = await take(matching);
    expect(rest).toEqual([]);
    expect(m!.fields).toMatchObject({ exchange, routingKey: 'manual.review' });
    expect(m!.properties.headers).toEqual({
      tenant: 'acme',
      'x-volveran-replay-id': expect.stringMatching(/^[0-9a-f-]{36}$/),
      'x-volveran-from': 'orders.dlq',
    });
    const { entries } = (await app.get(`/api/audit-entries?checkoutId=${id}`)).body;
    expect(entries).toEqual([
      expect.objectContaining({
        queue: 'orders.dlq',
        messageId: 'o-1',
        action: 'move',
        destination: { exchange, routingKey: 'manual.review', queue: null },
        outcome: 'done',
      }),
    ]);
    const { entry } = (await app.get(`/api/audit-entries/${entries[0].id}`)).body;
    expect(entry.message.body).toBeNull();
    expect(entry.message.headers).toMatchObject({
      tenant: 'acme',
      'x-death': [expect.objectContaining({ queue: 'orders.work', reason: 'rejected' })],
    });
  });
  it('only accepts an existing queue or exchange of the same vhost as a destination, other than the queue itself', async () => {
    await seedMessages('/', 'orders.dlq', 1);
    const { id, handle } = await startCheckout('orders.dlq');
    const h = [handle('orders.dlq-0')];

    for (const decision of [
      toQueue('no.such.queue'),
      toQueue('other.dlq'), // exists, but in vhost "other"
      toQueue('orders.dlq'),
      toExchange('no.such.exchange', 'x'),
    ]) {
      const res = await decide(id, h, decision);
      expect([res.status, res.body.error?.code], JSON.stringify(decision)).toEqual([422, 'decision_not_allowed']);
    }
    expect((await decide(id, h, { kind: 'move' })).status).toBe(400);
    expect((await app.get(`/api/checkouts/${id}`)).body.checkout.decisionSummaryText).toBe('1 Keep');
    expect((await decide(id, h, toExchange('orders', 'orders.manual'))).status).toBe(200);
  });
  it('fails a Move the broker cannot route, or whose destination was deleted mid-Checkout, falling back to Keep with the Checkout unaffected', async () => {
    const unbound = await tempExchange('move.unbound', 'direct');
    const doomedExchange = await tempExchange('move.doomed', 'fanout');
    const doomedQueue = await tempQueue('move.doomed');
    await withChannel('/', (ch) => ch.bindQueue('triage.manual', doomedExchange, ''));
    await deadLetter(
      deadLetterRoutes.classic,
      ['unroutable', 'k-1', 'gone-q', 'gone-x', 'ok', 'k-2'].map((m) => ({ body: m, options: { messageId: m } })),
    );
    const { id, handle } = await startCheckout('orders.dlq');
    const decisions = {
      unroutable: toExchange(unbound, 'nobody'),
      'gone-q': toQueue(doomedQueue),
      'gone-x': toExchange(doomedExchange, ''),
      ok: toQueue('triage.manual'),
    };
    for (const [m, decision] of Object.entries(decisions)) expect((await decide(id, [handle(m)], decision)).status).toBe(200);
    await withChannel('/', async (ch) => {
      await ch.deleteQueue(doomedQueue);
      await ch.deleteExchange(doomedExchange);
    });

    const applied = await apply(id);

    expect(applied.status).toBe(202);
    const status = Object.fromEntries(applied.body.outcomes.map((o: any) => [o.messageId, [o.status, o.reason]]));
    expect(status).toEqual({
      unroutable: ['failed', expect.stringMatching(/could not route/)],
      'k-1': ['kept', null],
      'gone-q': ['failed', expect.stringContaining(doomedQueue)],
      'gone-x': ['failed', expect.stringContaining(doomedExchange)],
      ok: ['done', null],
      'k-2': ['kept', null],
    });
    // The failed Moves fell back to Keep, in place; the Checkout channel still acked the later step.
    expect(await readyMessageIds('/', 'orders.dlq')).toEqual(['unroutable', 'k-1', 'gone-q', 'gone-x', 'k-2']);
    expect(await readyMessageIds('/', 'triage.manual')).toEqual(['ok']);
    const { entries } = (await app.get(`/api/audit-entries?checkoutId=${id}&action=move`)).body;
    expect(Object.fromEntries(entries.map((e: any) => [e.messageId, e.outcome]))).toEqual({
      unroutable: 'failed',
      'gone-q': 'failed',
      'gone-x': 'failed',
      ok: 'done',
    });
  });
  it('stores the replay id in the Audit Entry, so a Message that dies again can be traced back to its Move', async () => {
    await seedMessages('/', 'orders.dlq', 2);
    const { id, handle } = await startCheckout('orders.dlq');
    await decide(id, [handle('orders.dlq-0'), handle('orders.dlq-1')], toQueue('triage.manual'));

    expect((await apply(id)).status).toBe(202);

    const arrived = await take('triage.manual');
    const replayIds = Object.fromEntries(arrived.map((m) => [m.properties.messageId, m.properties.headers?.['x-volveran-replay-id']]));
    const { entries } = (await app.get(`/api/audit-entries?checkoutId=${id}`)).body;
    expect(Object.fromEntries(entries.map((e: any) => [e.messageId, e.replayId]))).toEqual(replayIds);

    const found = (await app.get(`/api/audit-entries?replayId=${replayIds['orders.dlq-1']}`)).body.entries;
    expect(found).toEqual([expect.objectContaining({ messageId: 'orders.dlq-1', action: 'move', replayId: replayIds['orders.dlq-1'] })]);
    expect((await app.get(`/api/audit-entries?replayId=00000000-0000-0000-0000-000000000000`)).body.entries).toEqual([]);
  });
  it('lists the queues and the exchanges a Move can go to in a vhost, for the destination picker', async () => {
    const internal = uniqueName('move.internal');
    tempExchanges.push(internal);
    await withChannel('/', (ch) => ch.assertExchange(internal, 'fanout', { internal: true }));
    await seedMessages('/', 'orders.dlq', 1);
    await startCheckout('orders.dlq'); // its lock queue is not a destination

    const res = await app.get('/api/profiles/local/vhosts/%2F/move-destinations');

    expect(res.status).toBe(200);
    expect(res.body.queues).toEqual(expect.arrayContaining(['orders.dlq', 'triage.manual', 'payments.work']));
    expect(res.body.queues).not.toContain('other.dlq');
    expect(res.body.queues.filter((q: string) => q.startsWith('volveran.'))).toEqual([]);
    expect([...res.body.queues].sort()).toEqual(res.body.queues);
    expect(res.body.exchanges).toEqual(
      expect.arrayContaining([
        { name: 'orders', type: 'topic' },
        { name: 'orders.dlx', type: 'fanout' },
      ]),
    );
    const names = res.body.exchanges.map((e: any) => e.name);
    expect(names).not.toContain('');
    expect(names).not.toContain(internal);
    expect((await app.get('/api/profiles/local/vhosts/nope/move-destinations')).body.error.code).toBe('vhost_not_accessible');
  });
});
