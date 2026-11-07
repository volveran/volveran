// The demo's triage loop (site/demo/api/simulator): Checkout, Decisions,
// Apply and Audit Entries against the in-memory broker seeded with the
// screenshot scenario's Messages, through the API the web app calls. From the
// broker as seed.mjs leaves it (seededState), with an empty audit store.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDemoApi, type DemoApi } from '../../site/demo/api/demo-api.js';
import { seededState } from '../../site/demo/api/state.js';
import type { CheckoutView, MessageDetail } from '../../src/shared/checkout.js';
import { committedRecording } from '../support/demo-recording.js';

const origin = 'https://volveran.github.io';

async function call(api: DemoApi, method: string, path: string, body?: unknown) {
  const init: RequestInit = { method, ...(body !== undefined && { body: JSON.stringify(body), headers: { 'content-type': 'application/json' } }) };
  const res = await api.handle(new Request(`${origin}/api/v1${path}`, init));
  return { status: res.status, body: (await res.json()) as Record<string, any> };
}

async function startCheckout(api: DemoApi, profile = 'staging', queue = 'orders.dlq', body: unknown = { overrideConsumers: false }) {
  const res = await call(api, 'POST', `/profiles/${profile}/vhosts/%2F/queues/${encodeURIComponent(queue)}/checkouts`, body);
  return res;
}

async function started(api: DemoApi, profile = 'staging', queue = 'orders.dlq'): Promise<CheckoutView> {
  const res = await startCheckout(api, profile, queue);
  expect(res.status).toBe(201);
  return res.body.checkout as CheckoutView;
}

afterEach(() => {
  vi.useRealTimers();
});

describe('a Checkout in the demo', () => {
  it('holds the seeded Messages of orders.dlq on staging, every one Keep, for the Operator demo', async () => {
    const api = createDemoApi(seededState(committedRecording));
    const checkout = await started(api);
    expect(checkout).toMatchObject({
      profile: 'staging',
      protectedProfile: false,
      vhost: '/',
      queue: 'orders.dlq',
      queueType: 'classic',
      operator: 'demo',
      status: 'active',
      timeLimitMs: 1_800_000,
      heartbeatWindowMs: 120_000,
      readyAtStart: 15,
      heldCount: 15,
      decisionSummaryText: '15 Keep',
      endReason: null,
    });
    expect(checkout.messages.map((m) => m.messageId).slice(0, 2)).toEqual(['ord-7d09-0001', 'ord-9bf8-0002']);
    expect(checkout.messages.every((m) => m.decision.kind === 'keep')).toBe(true);
    expect(checkout.messages[0]).toMatchObject({
      routingKey: 'orders.created.eu',
      deadLetterReason: 'rejected',
      originalQueue: 'orders.work',
      replay: { available: true },
      diedAgain: null,
    });
    expect((await call(api, 'GET', '/session')).body.checkoutId).toBe(checkout.id);
  });
});

describe('a Message in a demo Checkout', () => {
  async function detail(api: DemoApi, checkout: CheckoutView, handle: number): Promise<MessageDetail> {
    const res = await call(api, 'GET', `/checkouts/${checkout.id}/messages/${handle}`);
    expect(res.status).toBe(200);
    return res.body.message as MessageDetail;
  }

  it('shows the protobuf order as hex and base64', async () => {
    const api = createDemoApi(seededState(committedRecording));
    const checkout = await started(api);
    const protobuf = checkout.messages.find((m) => m.messageId === 'ord-22e1b-0015')!;
    expect((await detail(api, checkout, protobuf.handle)).body).toEqual({
      kind: 'binary',
      size: 26,
      hex: '0a08d20910011a05455552ff007f220c534b552d41582d313134',
      base64: 'CgjSCRABGgVFVVL/AH8iDFNLVS1BWC0xMTQ=',
    });
  });

  it('shows the x-death the broker wrote when orders.work rejected it, and the Spring AMQP Failure Details', async () => {
    const api = createDemoApi(seededState(committedRecording));
    const checkout = await started(api);
    const message = await detail(api, checkout, 1);
    expect(message.exchange).toBe('orders.dlx');
    expect(message.xDeath).toEqual([
      { queue: 'orders.work', reason: 'rejected', count: 1, time: expect.stringMatching(/Z$/), exchange: 'orders', routingKeys: ['orders.created.eu'], originalExpiration: null },
    ]);
    expect(message.headers).toMatchObject({ 'x-first-death-queue': 'orders.work', 'x-last-death-reason': 'rejected', 'x-tenant': 'south' });
    expect(message.failureDetails).toMatchObject({
      framework: 'spring',
      message: 'Could not acquire JDBC connection; SQLTimeoutException: Connection is not available, request timed out after 30000ms.',
      originalExchange: 'orders',
      originalRoutingKey: 'orders.created.eu',
    });
    expect(message.properties).toMatchObject({ messageId: 'ord-7d09-0001', correlationId: 'corr-4410', timestamp: '2026-10-29T06:23:20.000Z' });
    expect(message.body).toMatchObject({ kind: 'json', text: expect.stringContaining('"orderId": 880210') });
    expect(message.deliveryBudget).toBeNull();
  });

  it('shows the Delivery Budget of a Message on the quorum queue payments.dlq', async () => {
    const api = createDemoApi(seededState(committedRecording));
    const checkout = await started(api, 'staging', 'payments.dlq');
    expect(checkout).toMatchObject({ queueType: 'quorum', deliveryLimit: 5, heldCount: 6 });
    expect((await detail(api, checkout, 1)).deliveryBudget).toEqual({ remaining: 5, warning: null });
  });

  it('answers a handle the Checkout does not hold as the server does', async () => {
    const api = createDemoApi(seededState(committedRecording));
    const checkout = await started(api);
    expect((await call(api, 'GET', `/checkouts/${checkout.id}/messages/99`)).body).toEqual({
      error: { code: 'message_not_found', message: `Checkout ${checkout.id} holds no Message with handle 99.` },
    });
  });
});

describe('selecting all matching Messages in the demo', () => {
  async function matching(api: DemoApi, checkout: CheckoutView, filter: unknown) {
    return call(api, 'POST', `/checkouts/${checkout.id}/matching`, { filter });
  }

  it('finds the SQLTimeoutException Messages by their Failure Details', async () => {
    const api = createDemoApi(seededState(committedRecording));
    const checkout = await started(api);
    expect((await matching(api, checkout, [{ kind: 'failure', value: 'sqltimeoutexception' }])).body).toEqual({ handles: [1, 4, 7, 10, 13], count: 5 });
  });

  it('ANDs the clauses: a routing key glob and a JSON path', async () => {
    const api = createDemoApi(seededState(committedRecording));
    const checkout = await started(api);
    const { body } = await matching(api, checkout, [
      { kind: 'routing-key', value: 'orders.created.*' },
      { kind: 'json-path', path: '$.currency', value: 'USD' },
    ]);
    // Orders 0..13 in USD are 0, 3, 6, 9, 12; created (eu or us) are those with i % 4 of 0 or 1.
    expect(body).toEqual({ handles: [1, 10, 13], count: 3 });
    expect((await matching(api, checkout, [])).body.count).toBe(15);
  });

  it('refuses a filter it cannot read, as the server does', async () => {
    const api = createDemoApi(seededState(committedRecording));
    const checkout = await started(api);
    expect(await matching(api, checkout, [{ kind: 'colour', value: 'red' }])).toEqual({
      status: 400,
      body: {
        error: {
          code: 'invalid_request',
          message: '"colour" is not a filter clause; use one of routing-key, header, x-death-reason, original-queue, body-text, json-path, died-again, failure.',
        },
      },
    });
  });
});

async function decide(api: DemoApi, checkout: CheckoutView, handles: number[], decision: unknown) {
  return call(api, 'POST', `/checkouts/${checkout.id}/decisions`, { handles, decision });
}

describe('Decisions in the demo', () => {
  it('are staged on the Messages given them; every other Message stays Keep', async () => {
    const api = createDemoApi(seededState(committedRecording));
    const checkout = await started(api);
    await decide(api, checkout, [1], { kind: 'discard', reason: 'Duplicate of order 880210, already fulfilled' });
    await decide(api, checkout, [2, 3], { kind: 'replay' });
    const { status, body } = await decide(api, checkout, [4], { kind: 'move', destination: { queue: 'orders.parked' } });
    expect(status).toBe(200);
    expect(body.rejected).toEqual([]);
    expect(body.checkout.decisionSummaryText).toBe('1 Discard, 2 Replay, 1 Move to orders.parked, 11 Keep');
    expect(body.checkout.messages[0].decision).toEqual({ kind: 'discard', reason: 'Duplicate of order 880210, already fulfilled' });
    expect(body.checkout.messages[4].decision).toEqual({ kind: 'keep' });

    const cleared = await decide(api, checkout, [2], { kind: 'keep' });
    expect(cleared.body.checkout.decisionSummaryText).toBe('1 Discard, 1 Replay, 1 Move to orders.parked, 12 Keep');
  });

  it('refuses a Discard without a reason and a Move to the queue being triaged, as the server does', async () => {
    const api = createDemoApi(seededState(committedRecording));
    const checkout = await started(api);
    expect(await decide(api, checkout, [1], { kind: 'discard', reason: ' ' })).toEqual({
      status: 400,
      body: { error: { code: 'invalid_request', message: 'A Discard needs a "reason": it is recorded in the Audit Entry.' } },
    });
    expect(await decide(api, checkout, [1], { kind: 'move', destination: { queue: 'orders.dlq' } })).toEqual({
      status: 422,
      body: { error: { code: 'decision_not_allowed', message: 'The Messages are already in "orders.dlq": Move them to another queue, or Keep them.' } },
    });
    expect((await decide(api, checkout, [1], { kind: 'move', destination: { queue: 'nowhere' } })).body.error.code).toBe('decision_not_allowed');
  });
});

/** The Checkout once its Apply, running in the background, has ended it. */
async function applied(api: DemoApi, checkout: CheckoutView, body: unknown = { confirm: true }): Promise<CheckoutView> {
  const res = await call(api, 'POST', `/checkouts/${checkout.id}/apply`, body);
  expect(res.status).toBe(202);
  expect(res.body.checkout.status).toBe('applying');
  for (let i = 0; i < 100; i++) {
    const { body: polled } = await call(api, 'GET', `/checkouts/${checkout.id}`);
    if (polled.checkout.status === 'ended') return polled.checkout as CheckoutView;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error('The Apply did not end the Checkout.');
}

async function depths(api: DemoApi, profile = 'staging') {
  const { body } = await call(api, 'GET', `/profiles/${profile}/vhosts/%2F/queues`);
  return Object.fromEntries((body.queues as Array<{ name: string; approximateMessages: number }>).map((q) => [q.name, q.approximateMessages]));
}

describe('Apply in the demo', () => {
  it('carries out the Decisions in the background, gives the outcome per Message and ends the Checkout', async () => {
    const api = createDemoApi(seededState(committedRecording));
    const checkout = await started(api);
    await decide(api, checkout, [1], { kind: 'discard', reason: 'Duplicate of order 880210, already fulfilled' });
    await decide(api, checkout, [2, 3], { kind: 'replay' });
    await decide(api, checkout, [4], { kind: 'move', destination: { queue: 'orders.parked' } });

    const ended = await applied(api, checkout);
    expect(ended).toMatchObject({ status: 'ended', endReason: 'applied', heldCount: 0, messages: [] });
    expect(ended.applyProgress).toMatchObject({ total: 4, done: 4, failed: 0, notAttempted: 0, remaining: 0, rate: null });
    const outcomes = ended.lastApply!.outcomes;
    expect(outcomes).toHaveLength(15);
    expect(outcomes.slice(0, 5).map(({ handle, status, decision }) => ({ handle, status, kind: decision.kind }))).toEqual([
      { handle: 1, status: 'done', kind: 'discard' },
      { handle: 2, status: 'done', kind: 'replay' },
      { handle: 3, status: 'done', kind: 'replay' },
      { handle: 4, status: 'done', kind: 'move' },
      { handle: 5, status: 'kept', kind: 'keep' },
    ]);
    expect((await call(api, 'GET', '/session')).body.checkoutId).toBeNull();
  });

  it('leaves the queue list depths as the outcome left them, and the Replayed Messages out of the dead-letter queue', async () => {
    const api = createDemoApi(seededState(committedRecording));
    expect(await depths(api)).toMatchObject({ 'orders.dlq': 15, 'orders.parked': 0, 'orders.work': 0 });
    const checkout = await started(api);
    const replayed = checkout.messages.slice(1, 3).map((m) => m.messageId);
    await decide(api, checkout, [1], { kind: 'discard', reason: 'Duplicate' });
    await decide(api, checkout, [2, 3], { kind: 'replay' });
    await decide(api, checkout, [4], { kind: 'move', destination: { queue: 'orders.parked' } });
    await applied(api, checkout);

    expect(await depths(api)).toMatchObject({ 'orders.dlq': 11, 'orders.parked': 1, 'orders.work': 0 });
    expect(await depths(api, 'production')).toMatchObject({ 'orders.dlq': 11 });
    const next = await started(api);
    expect(next.heldCount).toBe(11);
    expect(next.messages.map((m) => m.messageId)).not.toEqual(expect.arrayContaining([replayed[0]]));
    expect(next.messages.map((m) => m.messageId)).not.toEqual(expect.arrayContaining([replayed[1]]));
  });

  it('needs the Operator\'s confirmation, as the server does', async () => {
    const api = createDemoApi(seededState(committedRecording));
    const checkout = await started(api);
    expect((await call(api, 'POST', `/checkouts/${checkout.id}/apply`, {})).body.error.code).toBe('confirmation_required');
  });
});

describe('Keep in the demo', () => {
  it('is what a Decision that fails falls back to: the Message stays in the queue', async () => {
    const api = createDemoApi(seededState(committedRecording));
    const checkout = await started(api);
    await decide(api, checkout, [1], { kind: 'move', destination: { exchange: 'orders', routingKey: 'nowhere' } });
    const ended = await applied(api, checkout);
    expect(ended.lastApply!.outcomes[0]).toMatchObject({
      handle: 1,
      status: 'failed',
      reason: expect.stringContaining('Could not Move the Message to exchange orders with routing key nowhere'),
    });
    expect(ended.applyProgress).toMatchObject({ total: 1, done: 0, failed: 1 });
    const next = await started(api);
    expect(next.heldCount).toBe(15);
    expect(next.messages[0]!.messageId).toBe('ord-7d09-0001');
  });

  it('is what the steps an Operator stops before fall back to', async () => {
    vi.useFakeTimers();
    const api = createDemoApi(seededState(committedRecording));
    const checkout = await started(api);
    await decide(api, checkout, [2, 3, 4], { kind: 'replay' });
    const res = await call(api, 'POST', `/checkouts/${checkout.id}/apply`, { confirm: true, rate: 1 });
    expect(res.status).toBe(202);
    await vi.advanceTimersByTimeAsync(0);
    const stopped = await call(api, 'POST', `/checkouts/${checkout.id}/apply/stop`);
    expect(stopped.body.checkout.applyProgress).toMatchObject({ stoppedBy: 'demo', rate: 1 });
    await vi.advanceTimersByTimeAsync(0);
    const ended = (await call(api, 'GET', `/checkouts/${checkout.id}`)).body.checkout as CheckoutView;
    expect(ended).toMatchObject({ status: 'ended', endReason: 'applied' });
    expect(ended.lastApply!.outcomes.filter((o) => o.decision.kind === 'replay').map(({ status, reason }) => ({ status, reason }))).toEqual([
      { status: 'done', reason: null },
      { status: 'not-attempted', reason: 'Stopped by demo before this Message; it is back in the queue.' },
      { status: 'not-attempted', reason: 'Stopped by demo before this Message; it is back in the queue.' },
    ]);
    expect(await depths(api)).toMatchObject({ 'orders.dlq': 14 });
  });
});

describe('ending a demo Checkout', () => {
  it('returns every Message without an applied Decision to the queue, in order', async () => {
    const api = createDemoApi(seededState(committedRecording));
    const checkout = await started(api);
    await decide(api, checkout, [1, 2], { kind: 'discard', reason: 'Not needed' });
    const { status, body } = await call(api, 'DELETE', `/checkouts/${checkout.id}`);
    expect(status).toBe(200);
    expect(body.checkout).toMatchObject({ status: 'ended', endReason: 'operator', heldCount: 0, remainingMs: 0, lastApply: null });
    expect((await call(api, 'GET', '/session')).body.checkoutId).toBeNull();
    expect((await call(api, 'GET', '/audit-entries')).body.entries).toEqual([]);
    const next = await started(api);
    expect(next.messages.map((m) => m.messageId)).toEqual(checkout.messages.map((m) => m.messageId));
    expect(next.messages.every((m) => m.decision.kind === 'keep')).toBe(true);
  });

  it('refuses Decisions once it is over, as the server does', async () => {
    const api = createDemoApi(seededState(committedRecording));
    const checkout = await started(api);
    await call(api, 'POST', `/checkouts/${checkout.id}/end`);
    expect(await decide(api, checkout, [1], { kind: 'replay' })).toEqual({
      status: 409,
      body: {
        error: {
          code: 'checkout_not_active',
          message: 'The Checkout of "orders.dlq" in vhost "/" is over: its Messages are back in the queue. So its Messages can no longer take Decisions. Start a new Checkout.',
          status: 'ended',
          lostReason: null,
        },
      },
    });
  });

  it('happens by itself when the browser stops sending heartbeats for the heartbeat window', async () => {
    vi.useFakeTimers();
    const api = createDemoApi(seededState(committedRecording));
    const checkout = await started(api);
    await vi.advanceTimersByTimeAsync(100_000);
    expect((await call(api, 'POST', `/checkouts/${checkout.id}/heartbeat`)).body.checkout.status).toBe('active');
    await vi.advanceTimersByTimeAsync(100_000);
    expect((await call(api, 'GET', `/checkouts/${checkout.id}`)).body.checkout.status).toBe('active');
    await vi.advanceTimersByTimeAsync(20_001);
    expect((await call(api, 'GET', `/checkouts/${checkout.id}`)).body.checkout).toMatchObject({ status: 'ended', endReason: 'no-heartbeat' });
    expect(await depths(api)).toMatchObject({ 'orders.dlq': 15 });
  });

  it('happens by itself at the 30-minute time limit, heartbeats or not', async () => {
    vi.useFakeTimers();
    const api = createDemoApi(seededState(committedRecording));
    const checkout = await started(api);
    for (let minute = 0; minute < 30; minute++) {
      await call(api, 'POST', `/checkouts/${checkout.id}/heartbeat`);
      await vi.advanceTimersByTimeAsync(60_000);
    }
    expect((await call(api, 'GET', `/checkouts/${checkout.id}`)).body.checkout).toMatchObject({ status: 'ended', endReason: 'time-limit' });
  });
});

describe('Audit Entries in the demo', () => {
  async function appliedScenario(api: DemoApi) {
    const checkout = await started(api);
    await decide(api, checkout, [1], { kind: 'discard', reason: 'Duplicate of order 880210, already fulfilled' });
    await decide(api, checkout, [2], { kind: 'replay' });
    await decide(api, checkout, [4], { kind: 'move', destination: { queue: 'orders.parked' } });
    await applied(api, checkout);
    return checkout;
  }

  it('record every action under the Operator demo, newest first, without bodies', async () => {
    const api = createDemoApi(seededState(committedRecording));
    const checkout = await appliedScenario(api);
    const { body } = await call(api, 'GET', '/audit-entries?operator=demo');
    expect(body.entries.map((e: Record<string, unknown>) => [e.id, e.action, e.messageId, e.outcome])).toEqual([
      [3, 'move', 'ord-d9d6-0004', 'done'],
      [2, 'replay', 'ord-9bf8-0002', 'done'],
      [1, 'discard', 'ord-7d09-0001', 'done'],
    ]);
    expect(body.entries[2]).toMatchObject({
      operatorId: 'demo',
      operatorName: 'demo',
      role: 'admin',
      profile: 'staging',
      vhost: '/',
      queue: 'orders.dlq',
      checkoutId: checkout.id,
      reason: 'Duplicate of order 880210, already fulfilled',
      destination: null,
      replayId: null,
      message: { bodyBytes: 152 },
    });
    expect(body.entries[2].message.body).toBeUndefined();
    expect(body.entries[1]).toMatchObject({
      destination: { exchange: '', routingKey: 'orders.work', queue: 'orders.work' },
      replayId: expect.stringMatching(/^[0-9a-f-]{36}$/),
      message: { bodyBytes: null },
    });
  });

  it('keep a full copy of a Discarded Message, body included', async () => {
    const api = createDemoApi(seededState(committedRecording));
    await appliedScenario(api);
    const { status, body } = await call(api, 'GET', '/audit-entries/1');
    expect(status).toBe(200);
    const sent =
      '{"orderId":880210,"customerId":"c-10482","currency":"USD","lines":[{"sku":"SKU-AX-114","qty":1,"unitPrice":19.9}],"placedAt":"2026-10-29T06:10:41.118Z"}';
    expect(atob(body.entry.message.body)).toBe(sent);
    expect(body.entry.message.properties).toEqual({
      messageId: 'ord-7d09-0001',
      contentType: 'application/json',
      correlationId: 'corr-4410',
      timestamp: 1793255000,
      type: 'OrderPlaced',
      appId: 'orders-api',
      deliveryMode: 2,
    });
    expect(body.entry.message.headers).toMatchObject({
      'x-tenant': 'south',
      'x-exception-message': expect.stringContaining('SQLTimeoutException'),
      'x-death': [{ queue: 'orders.work', reason: 'rejected', count: 1, time: { '!': 'timestamp', value: expect.any(Number) } }],
    });
  });

  it('are searchable as the audit view searches them', async () => {
    const api = createDemoApi(seededState(committedRecording));
    await appliedScenario(api);
    const ids = async (query: string) => ((await call(api, 'GET', `/audit-entries?${query}`)).body.entries as Array<{ id: number }>).map((e) => e.id);
    expect(await ids('action=discard')).toEqual([1]);
    expect(await ids('queue=orders.parked')).toEqual([3]);
    expect(await ids('profile=production')).toEqual([]);
    expect(await ids('messageId=ord-9bf8-0002')).toEqual([2]);
    expect(await ids('operator=ana')).toEqual([]);
    expect(await ids('limit=1')).toEqual([3]);
    expect((await call(api, 'GET', '/audit-entries?action=purge')).body.error.code).toBe('invalid_request');
    expect((await call(api, 'GET', '/audit-entries/99')).body).toEqual({ error: { code: 'audit_entry_not_found', message: 'No Audit Entry 99.' } });
  });
});

describe('the queue list while a Checkout holds a queue', () => {
  it('shows who holds it, on every Broker Profile of the broker, and refuses a second Checkout', async () => {
    const api = createDemoApi(seededState(committedRecording));
    const checkout = await started(api);
    const { body } = await call(api, 'GET', '/profiles/production/vhosts/%2F/queues?onlyDeadLetterQueues=true');
    const row = (name: string) => body.queues.find((q: { name: string }) => q.name === name);
    expect(row('orders.dlq')).toMatchObject({ approximateMessages: 15, checkedOutBy: { operator: 'demo', since: checkout.startedAt } });
    expect(row('payments.dlq')).toMatchObject({ checkedOutBy: null });
    expect((await startCheckout(api, 'production', 'payments.dlq')).body.error.code).toBe('operator_has_checkout');
  });
});
