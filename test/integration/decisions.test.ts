// Selection, filters and Decisions through the HTTP API: "select all
// matching" over the held Messages, giving the Selection a Decision, changing
// and clearing it. Decisions live on the server for the Checkout (a reload
// reads them back) and nothing changes on the broker until Apply: the broker
// is checked independently over AMQP.
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  deadLetter,
  deadLetterRoutes,
  fixtureQueues,
  purgeQueues,
  readyCount,
  readyMessageIds,
  seedMessages,
  startApp,
  testProfile,
  type TestApp,
} from './harness.js';

const checkoutPath = (queue: string) => `/api/profiles/local/vhosts/%2F/queues/${encodeURIComponent(queue)}/checkouts`;

const json = (body: unknown) => ({ body: JSON.stringify(body), options: { contentType: 'application/json' } });

/** Four dead-lettered Messages a–d in orders.dlq (real x-death from orders.work). */
async function seedOrders() {
  const m = (messageId: string, routingKey: string, tenant: string, body: unknown) => {
    const seed = json(body);
    return { body: seed.body, routingKey, options: { ...seed.options, messageId, headers: { tenant } } };
  };
  await deadLetter(deadLetterRoutes.classic, [
    m('a', 'orders.created', 'acme', { order: { id: 'A-1', country: 'ES' }, error: 'card declined' }),
    m('b', 'orders.created', 'globex', { order: { id: 'B-2', country: 'FR' }, error: 'card declined' }),
    m('c', 'orders.cancelled', 'acme', { order: { id: 'C-3', country: 'ES' }, error: 'timeout' }),
    {
      body: 'plain text, not JSON: card declined',
      routingKey: 'orders.created',
      options: { messageId: 'd', headers: { tenant: 'acme' } },
    },
  ]);
}

describe('Selection, filters and Decisions', () => {
  let app: TestApp;
  const open: string[] = [];

  async function startCheckout(queue = 'orders.dlq') {
    const res = await app.post(checkoutPath(queue));
    expect(res.status).toBe(201);
    open.push(res.body.checkout.id);
    const checkout = res.body.checkout;
    const handle = (messageId: string): number => checkout.messages.find((m: any) => m.messageId === messageId).handle;
    return { id: checkout.id as string, handle };
  }

  const matching = (id: string, filter: unknown) => app.post(`/api/checkouts/${id}/matching`, { filter });
  const decide = (id: string, handles: number[], decision: unknown) =>
    app.post(`/api/checkouts/${id}/decisions`, { handles, decision });

  beforeAll(async () => {
    app = await startApp({ profiles: [testProfile({ name: 'local' })] });
  });
  afterEach(async () => {
    while (open.length) await app.delete(`/api/checkouts/${open.pop()}`);
    await purgeQueues('/', fixtureQueues);
  });
  afterAll(async () => {
    await app?.close();
  });

  it('selects the held Messages matching each filter kind, in Checkout order', async () => {
    await seedOrders();
    const { id, handle } = await startCheckout();

    const byFilter = async (filter: unknown) => {
      const res = await matching(id, filter);
      expect(res.status).toBe(200);
      return res.body;
    };

    expect(await byFilter([{ kind: 'routing-key', value: 'orders.created' }])).toEqual({
      handles: [handle('a'), handle('b'), handle('d')],
      count: 3,
    });
    expect((await byFilter([{ kind: 'header', name: 'tenant', value: 'acme' }])).handles).toEqual([
      handle('a'),
      handle('c'),
      handle('d'),
    ]);
    // Real x-death headers written by the broker.
    expect((await byFilter([{ kind: 'x-death-reason', value: 'rejected' }])).count).toBe(4);
    expect((await byFilter([{ kind: 'original-queue', value: 'orders.work' }])).count).toBe(4);
    expect((await byFilter([{ kind: 'original-queue', value: 'payments.*' }])).count).toBe(0);
    expect((await byFilter([{ kind: 'body-text', value: 'CARD DECLINED' }])).handles).toEqual([
      handle('a'),
      handle('b'),
      handle('d'),
    ]);
    expect((await byFilter([{ kind: 'json-path', path: '$.order.country', value: 'ES' }])).handles).toEqual([
      handle('a'),
      handle('c'),
    ]);
    expect(
      (
        await byFilter([
          { kind: 'routing-key', value: 'orders.created' },
          { kind: 'header', name: 'tenant', value: 'acme' },
          { kind: 'body-text', value: 'card declined' },
        ])
      ).handles,
    ).toEqual([handle('a'), handle('d')]);
    expect((await byFilter([])).count).toBe(4);
  });

  it('matches only held Messages, not ones that arrived after the Checkout started', async () => {
    await seedOrders();
    const { id } = await startCheckout();
    await seedOrders();
    expect(await readyCount('/', 'orders.dlq')).toBe(4);

    expect((await matching(id, [{ kind: 'x-death-reason', value: 'rejected' }])).body.count).toBe(4);
  });

  it('keeps Decisions on the server across a reload, and changes nothing on the broker', async () => {
    await seedOrders();
    const { id, handle } = await startCheckout();

    const declined = await matching(id, [{ kind: 'body-text', value: 'card declined' }]);
    const discarded = await decide(id, declined.body.handles, { kind: 'discard', reason: 'Card declined for good' });
    expect(discarded.status).toBe(200);
    expect(discarded.body.rejected).toEqual([]);
    expect((await decide(id, [handle('b')], { kind: 'replay' })).status).toBe(200);
    expect((await decide(id, [handle('c')], { kind: 'move', destination: { queue: 'triage.manual' } })).status).toBe(200);

    // A reload: the page reads the Checkout afresh.
    const reloaded = await app.get(`/api/checkouts/${id}`);
    expect(reloaded.status).toBe(200);
    const rows = Object.fromEntries(reloaded.body.checkout.messages.map((m: any) => [m.messageId, m.decision]));
    expect(rows).toEqual({
      a: { kind: 'discard', reason: 'Card declined for good' },
      b: { kind: 'replay' },
      c: { kind: 'move', destination: { queue: 'triage.manual' } },
      d: { kind: 'discard', reason: 'Card declined for good' },
    });
    expect(reloaded.body.checkout.decisionSummary).toEqual([
      { kind: 'discard', count: 2 },
      { kind: 'replay', count: 1 },
      { kind: 'move', destination: { queue: 'triage.manual' }, count: 1 },
    ]);
    expect(reloaded.body.checkout.decisionSummaryText).toBe('2 Discard, 1 Replay, 1 Move to triage.manual');
    expect(reloaded.body.checkout.applyConfirmation).toEqual({ typeQueueName: false, approvalRequired: false });

    // Nothing reached the broker: the Messages are still held, nothing was
    // published anywhere, and ending the Checkout returns all four in order.
    expect(await readyCount('/', 'orders.dlq')).toBe(0);
    expect(await readyCount('/', 'triage.manual')).toBe(0);
    expect(await readyCount('/', 'orders.work')).toBe(0);
    expect((await app.delete(`/api/checkouts/${open.pop()}`)).status).toBe(200);
    expect(await readyMessageIds('/', 'orders.dlq')).toEqual(['a', 'b', 'c', 'd']);
    expect(await readyCount('/', 'triage.manual')).toBe(0);
  });

  it('starts every Message as Keep, and changes or clears a Decision', async () => {
    await seedOrders();
    const { id, handle } = await startCheckout();
    const start = await app.get(`/api/checkouts/${id}`);
    expect(start.body.checkout.messages.map((m: any) => m.decision)).toEqual(Array(4).fill({ kind: 'keep' }));
    expect(start.body.checkout.decisionSummaryText).toBe('4 Keep');

    await decide(id, [handle('a'), handle('b')], { kind: 'replay' });
    await decide(id, [handle('a')], { kind: 'move', destination: { exchange: 'orders', routingKey: 'orders.retry' } });
    const cleared = await decide(id, [handle('b')], { kind: 'keep' });

    expect(cleared.body.checkout.messages.map((m: any) => m.decision)).toEqual([
      { kind: 'move', destination: { exchange: 'orders', routingKey: 'orders.retry' } },
      { kind: 'keep' },
      { kind: 'keep' },
      { kind: 'keep' },
    ]);
    expect(cleared.body.checkout.decisionSummaryText).toBe(
      '1 Move to exchange orders with routing key orders.retry, 3 Keep',
    );
  });

  it('makes Replay unavailable, with the reason, for a Message with no x-death history', async () => {
    await seedOrders();
    await seedMessages('/', 'orders.dlq', 1); // published straight in: no x-death
    const { id, handle } = await startCheckout();

    const { body } = await app.get(`/api/checkouts/${id}`);
    const replay = Object.fromEntries(body.checkout.messages.map((m: any) => [m.messageId, m.replay]));
    expect(replay.a).toEqual({ available: true });
    expect(replay['orders.dlq-0']).toEqual({ available: false, reason: expect.stringMatching(/no x-death history/) });

    const all = body.checkout.messages.map((m: any) => m.handle);
    const res = await decide(id, all, { kind: 'replay' });
    expect(res.status).toBe(200);
    expect(res.body.rejected).toEqual([
      { handle: handle('orders.dlq-0'), reason: expect.stringMatching(/no x-death history/) },
    ]);
    expect(res.body.checkout.decisionSummaryText).toBe('4 Replay, 1 Keep');
  });

  it('refuses a Discard without a reason, a Move to the queue itself, and unknown Messages', async () => {
    await seedOrders();
    const { id, handle } = await startCheckout();

    const noReason = await decide(id, [handle('a')], { kind: 'discard' });
    expect(noReason.status).toBe(400);
    expect(noReason.body.error).toMatchObject({ code: 'invalid_request', message: expect.stringMatching(/reason/) });

    const toItself = await decide(id, [handle('a')], { kind: 'move', destination: { queue: 'orders.dlq' } });
    expect(toItself.status).toBe(422);
    expect(toItself.body.error.code).toBe('decision_not_allowed');

    const badHandles = await app.post(`/api/checkouts/${id}/decisions`, { handles: 'all', decision: { kind: 'keep' } });
    expect(badHandles.status).toBe(400);

    const unknown = await decide(id, [handle('a'), 999_999], { kind: 'discard', reason: 'x' });
    expect(unknown.status).toBe(200);
    expect(unknown.body.rejected).toEqual([{ handle: 999_999, reason: expect.stringMatching(/holds no Message/) }]);

    const after = await app.get(`/api/checkouts/${id}`);
    expect(after.body.checkout.decisionSummaryText).toBe('1 Discard, 3 Keep');
  });

  it('refuses a malformed filter and an unknown Checkout', async () => {
    await seedOrders();
    const { id } = await startCheckout();

    const bad = await matching(id, [{ kind: 'json-path', path: 'items[x]' }]);
    expect(bad.status).toBe(400);
    expect(bad.body.error).toMatchObject({ code: 'invalid_request', message: expect.stringMatching(/Invalid JSON path/) });
    expect((await app.post(`/api/checkouts/${id}/matching`, {})).status).toBe(400);

    const unknown = await matching('no-such-checkout', []);
    expect(unknown.status).toBe(404);
    expect(unknown.body.error.code).toBe('checkout_not_found');
  });

  it('refuses Decisions on a Checkout that has ended', async () => {
    await seedOrders();
    const { id, handle } = await startCheckout();
    await app.delete(`/api/checkouts/${open.pop()}`);

    const res = await decide(id, [handle('a')], { kind: 'replay' });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('checkout_not_active');
  });

  it('lists a Protected Profile Apply as needing the typed queue name once something is decided', async () => {
    const guarded = await startApp({ profiles: [testProfile({ name: 'local', protected: true })] });
    try {
      await seedOrders();
      const started = await guarded.post(checkoutPath('orders.dlq'));
      const id = started.body.checkout.id;
      expect(started.body.checkout.applyConfirmation).toEqual({ typeQueueName: false, approvalRequired: false });
      const res = await guarded.post(`/api/checkouts/${id}/decisions`, {
        handles: [started.body.checkout.messages[0].handle],
        decision: { kind: 'discard', reason: 'x' },
      });
      expect(res.body.checkout.applyConfirmation).toEqual({ typeQueueName: true, approvalRequired: false });
      await guarded.delete(`/api/checkouts/${id}`);
    } finally {
      await guarded.close();
    }
  });
});

