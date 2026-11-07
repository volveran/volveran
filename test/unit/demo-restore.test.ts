// The rest of what a visitor reaches in the demo (site/demo/api): Restore of a
// Discarded Message from the audit log, export of a Checkout, Compare, the
// audit store usage, the Alert Destination test and the Approval routes Solo
// Mode never reaches, through the API the web app calls. From the broker as
// seed.mjs leaves it (seededState), with an empty audit store.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDemoApi, type DemoApi } from '../../site/demo/api/demo-api.js';
import { seededState } from '../../site/demo/api/state.js';
import { fromAmqpJson } from '../../src/server/audit/amqp-json.js';
import { exportLine } from '../../src/server/triage/export-line.js';
import type { CheckoutView } from '../../src/shared/checkout.js';
import type { ExportLine } from '../../src/shared/export.js';
import { committedRecording } from '../support/demo-recording.js';

const origin = 'https://volveran.github.io';

afterEach(() => {
  vi.restoreAllMocks();
});

async function call(api: DemoApi, method: string, path: string, body?: unknown) {
  const res = await raw(api, method, path, body);
  return { status: res.status, body: (await res.json()) as Record<string, any> };
}

async function raw(api: DemoApi, method: string, path: string, body?: unknown) {
  const init: RequestInit = { method, ...(body !== undefined && { body: JSON.stringify(body), headers: { 'content-type': 'application/json' } }) };
  return api.handle(new Request(`${origin}/api/v1${path}`, init));
}

async function started(api: DemoApi, profile = 'staging', queue = 'orders.dlq'): Promise<CheckoutView> {
  const res = await call(api, 'POST', `/profiles/${profile}/vhosts/%2F/queues/${encodeURIComponent(queue)}/checkouts`, { overrideConsumers: false });
  expect(res.status).toBe(201);
  return res.body.checkout as CheckoutView;
}

async function decide(api: DemoApi, checkout: CheckoutView, handles: number[], decision: unknown) {
  return call(api, 'POST', `/checkouts/${checkout.id}/decisions`, { handles, decision });
}

/** The Checkout once its Apply, running in the background, has ended it. */
async function applied(api: DemoApi, checkout: CheckoutView, body: unknown = { confirm: true }): Promise<CheckoutView> {
  const res = await call(api, 'POST', `/checkouts/${checkout.id}/apply`, body);
  expect(res.status).toBe(202);
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

/** Discards the head of orders.dlq on `profile` (Audit Entry 1) and returns its message_id. */
async function discardedHead(api: DemoApi, profile = 'staging'): Promise<string> {
  const checkout = await started(api, profile);
  await decide(api, checkout, [1], { kind: 'discard', reason: 'Duplicate of order 880210, already fulfilled' });
  await applied(api, checkout, profile === 'production' ? { confirm: true, confirmQueueName: 'orders.dlq' } : { confirm: true });
  return checkout.messages[0]!.messageId!;
}

describe('Restore in the demo', () => {
  it('puts a Discarded Message back in the queue it was Discarded from and records its own Audit Entry', async () => {
    const api = createDemoApi(seededState(committedRecording));
    const messageId = await discardedHead(api);
    expect((await depths(api))['orders.dlq']).toBe(14);

    const { status, body } = await call(api, 'POST', '/audit-entries/1/restore', { confirm: true });
    expect(status).toBe(200);
    expect(body.entry).toMatchObject({
      id: 2,
      action: 'restore',
      restoreOf: 1,
      outcome: 'done',
      operatorId: 'demo',
      role: 'admin',
      profile: 'staging',
      vhost: '/',
      queue: 'orders.dlq',
      messageId,
      checkoutId: null,
      destination: { exchange: '', routingKey: 'orders.dlq', queue: 'orders.dlq' },
      replayId: expect.stringMatching(/^[0-9a-f-]{36}$/),
      message: null,
    });
    expect((await depths(api))['orders.dlq']).toBe(15);
    const next = await started(api);
    expect(next.messages.at(-1)!.messageId).toBe(messageId);
  });

  it('puts it in another existing queue with a new replay id, so that it is Died Again if it is dead-lettered again', async () => {
    const api = createDemoApi(seededState(committedRecording));
    const messageId = await discardedHead(api);
    const { body } = await call(api, 'POST', '/audit-entries/1/restore', { confirm: true, queue: 'orders.parked' });
    expect(body.entry).toMatchObject({ outcome: 'done', queue: 'orders.dlq', destination: { queue: 'orders.parked' } });
    const { replayId } = body.entry;

    const parked = await started(api, 'staging', 'orders.parked');
    expect(parked.messages.map((m) => m.messageId)).toEqual([messageId]);
    const detail = (await call(api, 'GET', `/checkouts/${parked.id}/messages/1`)).body.message;
    expect(detail.headers).toMatchObject({ 'x-volveran-replay-id': replayId, 'x-volveran-from': 'orders.dlq', 'x-tenant': 'south' });
    expect(Object.keys(detail.headers).filter((h) => h.startsWith('x-death') || h.startsWith('x-exception-'))).toEqual([]);
    expect((await call(api, 'POST', `/checkouts/${parked.id}/matching`, { filter: [{ kind: 'died-again' }] })).body.handles).toEqual([1]);
    // The trail Died Again follows back (#150): the replay id leads to the Restore's Audit Entry.
    expect((await call(api, 'GET', `/audit-entries?replayId=${replayId}`)).body.entries.map((e: { id: number }) => e.id)).toEqual([2]);
  });

  it('on the Protected Profile production, needs the destination queue name typed exactly', async () => {
    const api = createDemoApi(seededState(committedRecording));
    await discardedHead(api, 'production');
    expect(await call(api, 'POST', '/audit-entries/1/restore', { confirm: true, confirmQueueName: 'orders.DLQ' })).toEqual({
      status: 400,
      body: {
        error: {
          code: 'queue_name_confirmation_required',
          message: 'production is a Protected Profile: Restore needs the queue name typed exactly. Send { "confirmQueueName": "orders.dlq" } along with the confirmation.',
        },
      },
    });
    const { status, body } = await call(api, 'POST', '/audit-entries/1/restore', { confirm: true, confirmQueueName: 'orders.dlq' });
    expect(status).toBe(200);
    expect(body.entry).toMatchObject({ action: 'restore', profile: 'production', outcome: 'done' });
  });

  it('refuses what the server refuses: no confirmation, a queue that does not exist, a second Restore, an entry that is not a Discard', async () => {
    const api = createDemoApi(seededState(committedRecording));
    await discardedHead(api);
    const restore = (id: number | string, body: unknown) => call(api, 'POST', `/audit-entries/${id}/restore`, body);
    expect(await restore(1, {})).toEqual({
      status: 400,
      body: { error: { code: 'confirmation_required', message: 'Restore needs the Operator\'s confirmation: send { "confirm": true }.' } },
    });
    expect(await restore(1, { confirm: true, queue: 'nowhere' })).toEqual({
      status: 422,
      body: {
        error: {
          code: 'queue_not_found',
          message: 'Queue "nowhere" does not exist in vhost "/" (or Broker Profile "staging" cannot see it). Pick an existing queue.',
        },
      },
    });
    expect((await restore(1, { confirm: true })).status).toBe(200);
    expect(await restore(1, { confirm: true })).toEqual({
      status: 409,
      body: { error: { code: 'already_restored', message: 'The Message of Audit Entry 1 was already Restored to "orders.dlq" (Audit Entry 2).' } },
    });
    expect(await restore(2, { confirm: true })).toEqual({
      status: 422,
      body: { error: { code: 'not_restorable', message: 'Audit Entry 2 is not a carried-out Discard, so it has no removed Message to Restore.' } },
    });
    expect(await restore(9, { confirm: true })).toEqual({ status: 404, body: { error: { code: 'audit_entry_not_found', message: 'No Audit Entry 9.' } } });
  });
});

describe('export in the demo', () => {
  it('downloads the held Messages as Volverán\'s NDJSON, one line each in queue order, with their Decisions', async () => {
    const api = createDemoApi(seededState(committedRecording));
    const checkout = await started(api);
    await decide(api, checkout, [1], { kind: 'discard', reason: 'Duplicate' });
    const res = await raw(api, 'POST', `/checkouts/${checkout.id}/export`, {});
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/x-ndjson; charset=utf-8');
    expect(res.headers.get('content-disposition')).toMatch(/^attachment; filename="volveran-staging-orders\.dlq-\d{8}T\d{6}Z\.ndjson"$/);
    expect(res.headers.get('x-volveran-message-count')).toBe('15');
    const text = await res.text();
    expect(text.endsWith('\n')).toBe(true);
    const lines = text.trimEnd().split('\n').map((l) => JSON.parse(l) as ExportLine);
    expect(lines.map((l) => l.position)).toEqual(Array.from({ length: 15 }, (_, i) => i + 1));
    expect(lines[0]).toMatchObject({
      v: 1,
      messageId: 'ord-7d09-0001',
      exchange: 'orders.dlx',
      routingKey: 'orders.created.eu',
      properties: { messageId: 'ord-7d09-0001', contentType: 'application/json', timestamp: 1793255000, deliveryMode: 2 },
      bodyKind: 'json',
      decision: { kind: 'discard', reason: 'Duplicate' },
      diedAgain: null,
      deliveryBudget: null,
      failureDetails: { framework: 'spring' },
    });
    expect(atob(lines[0]!.body)).toContain('"orderId":880210');
    expect(lines[1]!.decision).toEqual({ kind: 'keep' });
    expect(lines.find((l) => l.messageId === 'ord-22e1b-0015')!.bodyKind).toBe('binary');
  });

  it('writes each line as the server writes it for the same Message', async () => {
    const api = createDemoApi(seededState(committedRecording));
    const checkout = await started(api);
    const text = await (await raw(api, 'POST', `/checkouts/${checkout.id}/export`, {})).text();
    const info = { type: 'classic' as const, deliveryLimit: null, deadLetterExchange: false };
    for (const line of text.trimEnd().split('\n').map((l) => JSON.parse(l) as ExportLine)) {
      const delivery = {
        fields: { exchange: line.exchange, routingKey: line.routingKey, redelivered: false },
        properties: { ...(fromAmqpJson(line.properties) as Record<string, unknown>), headers: fromAmqpJson(line.headers) as Record<string, unknown> },
        content: Buffer.from(line.body, 'base64'),
      };
      expect(line).toEqual(JSON.parse(JSON.stringify(exportLine(line.position, delivery, info, line.decision))));
    }
  });

  it('exports only the Messages a filter matches, and records an export Audit Entry', async () => {
    const api = createDemoApi(seededState(committedRecording));
    const checkout = await started(api);
    const filter = [{ kind: 'failure', value: 'SQLTimeoutException' }];
    const matching = (await call(api, 'POST', `/checkouts/${checkout.id}/matching`, { filter })).body.handles as number[];
    const res = await raw(api, 'POST', `/checkouts/${checkout.id}/export`, { filter });
    const lines = (await res.text()).trimEnd().split('\n').map((l) => JSON.parse(l) as ExportLine);
    expect(lines.map((l) => l.position)).toEqual(matching);
    const { body } = await call(api, 'GET', '/audit-entries?action=export');
    expect(body.entries).toEqual([
      expect.objectContaining({ action: 'export', operatorId: 'demo', checkoutId: checkout.id, queue: 'orders.dlq', filter, messageCount: matching.length, message: null, outcome: 'done' }),
    ]);
  });

  it('refuses a filter it cannot read and a Checkout that is over, as the server does', async () => {
    const api = createDemoApi(seededState(committedRecording));
    const checkout = await started(api);
    expect((await call(api, 'POST', `/checkouts/${checkout.id}/export`, { filter: [{ kind: 'colour' }] })).body.error.code).toBe('invalid_request');
    await call(api, 'POST', `/checkouts/${checkout.id}/end`);
    expect((await call(api, 'POST', `/checkouts/${checkout.id}/export`, {})).body.error).toMatchObject({
      code: 'checkout_not_active',
      message: 'The Checkout of "orders.dlq" in vhost "/" is over: its Messages are back in the queue. So its Messages can no longer be exported. Start a new Checkout.',
    });
  });
});

describe('Compare in the demo', () => {
  it('shows what differs between two Messages of the Checkout: properties, headers and the JSON body by path', async () => {
    const api = createDemoApi(seededState(committedRecording));
    const checkout = await started(api);
    const { status, body } = await call(api, 'GET', `/checkouts/${checkout.id}/compare?a=1&b=2`);
    expect(status).toBe(200);
    expect(body.left.messageId).toBe('ord-7d09-0001');
    expect(body.right.messageId).toBe('ord-9bf8-0002');
    expect(body.diff.properties).toContainEqual({ name: 'messageId', status: 'changed', left: 'ord-7d09-0001', right: 'ord-9bf8-0002' });
    expect(body.diff.body).toMatchObject({ kind: 'json', equal: false });
    expect(body.diff.body.changes).toContainEqual({ path: '$.orderId', status: 'changed', left: 880210, right: expect.any(Number) });
    expect(body.diff.xDeath).toHaveLength(1);
  });

  it('compares the protobuf order with a JSON one as bodies of different kinds, and two binary bodies byte by byte', async () => {
    const api = createDemoApi(seededState(committedRecording));
    const checkout = await started(api);
    const protobuf = checkout.messages.find((m) => m.messageId === 'ord-22e1b-0015')!.handle;
    const { body } = await call(api, 'GET', `/checkouts/${checkout.id}/compare?a=1&b=${protobuf}`);
    expect(body.diff.body).toEqual({ kind: 'mixed', equal: false, leftKind: 'json', rightKind: 'binary' });
  });

  it('refuses the same Message twice and a handle the Checkout does not hold, as the server does', async () => {
    const api = createDemoApi(seededState(committedRecording));
    const checkout = await started(api);
    expect(await call(api, 'GET', `/checkouts/${checkout.id}/compare?a=1&b=1`)).toEqual({
      status: 400,
      body: { error: { code: 'invalid_request', message: 'Compare two different Messages: "a" and "b" are the same handle.' } },
    });
    expect((await call(api, 'GET', `/checkouts/${checkout.id}/compare?a=1`)).body.error.message).toBe('Name the two Messages to compare with "a" and "b".');
    expect((await call(api, 'GET', `/checkouts/${checkout.id}/compare?a=1&b=x`)).body.error).toEqual({ code: 'message_not_found', message: '"x" is not a Message handle.' });
    expect((await call(api, 'GET', `/checkouts/${checkout.id}/compare?a=1&b=99`)).body.error.code).toBe('message_not_found');
  });
});

describe('the audit store usage in the demo', () => {
  it('counts the bodies of the Discarded Messages against Volverán\'s default limits', async () => {
    const api = createDemoApi(seededState(committedRecording));
    expect(await call(api, 'GET', '/audit-store')).toEqual({
      status: 200,
      body: { storedBodyBytes: 0, maxBodyBytes: 1024 ** 3, maxAgeDays: 30, nearLimit: false },
    });
    await discardedHead(api);
    expect((await call(api, 'GET', '/audit-store')).body.storedBodyBytes).toBe(152);
  });
});

describe('a test notification in the demo', () => {
  it('answers as delivered to the Alert Destination, with no network request', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const { status, body } = await call(createDemoApi(seededState(committedRecording)), 'POST', '/alert-destinations/ops-slack/test', {});
    expect(status).toBe(200);
    expect(body.delivery).toMatchObject({
      destination: 'ops-slack',
      destinationType: 'webhook',
      test: true,
      status: 'firing',
      rule: 'Test notification',
      alertId: expect.stringMatching(/^test-/),
      profile: null,
      outcome: 'delivered',
      attempts: 1,
      error: null,
    });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('lists the test notification first among the notifications of GET /alerts, as the server records it', async () => {
    const api = createDemoApi(seededState(committedRecording));
    const before = (await call(api, 'GET', '/alerts')).body.notifications as Array<{ id: number }>;
    const { body } = await call(api, 'POST', '/alert-destinations/ops-slack/test', {});
    const after = (await call(api, 'GET', '/alerts')).body.notifications as Array<{ id: number }>;
    expect(after[0]).toEqual(body.delivery);
    expect(after.slice(1)).toEqual(before.slice(0, 99));
  });

  it('refuses an Alert Destination the profiles file does not declare, as the server does', async () => {
    expect(await call(createDemoApi(seededState(committedRecording)), 'POST', '/alert-destinations/pager/test', {})).toEqual({
      status: 404,
      body: { error: { code: 'alert_destination_not_found', message: 'The profiles file declares no Alert Destination named "pager".' } },
    });
  });
});

describe('Approval in the demo', () => {
  const approvalRoutes: Array<[string, string]> = [
    ['GET', '/approvals'],
    ['GET', '/approvals/c-1'],
    ['GET', '/approvals/c-1/messages/1'],
    ['GET', '/approvals/c-1/compare?a=1&b=2'],
    ['POST', '/approvals/c-1/approve'],
    ['POST', '/approvals/c-1/reject'],
    ['POST', '/approvals/c-1/apply/stop'],
    ['POST', '/approvals/c-1/apply/continue'],
    ['POST', '/checkouts/c-1/approval-request'],
    ['DELETE', '/checkouts/c-1/approval-request'],
  ];

  it.each(approvalRoutes)('%s %s answers 404: Approval needs Team Mode', async (method, path) => {
    expect(await call(createDemoApi(seededState(committedRecording)), method, path)).toEqual({
      status: 404,
      body: { error: { code: 'not_in_demo', message: 'Not in the demo: Approval needs Team Mode.' } },
    });
  });

  it('lists the Approval routes as left out of the demo', () => {
    expect(createDemoApi(seededState(committedRecording)).routes().notInDemo).toEqual(
      expect.arrayContaining(['GET /api/v1/approvals', 'POST /api/v1/checkouts/{id}/approval-request', 'DELETE /api/v1/checkouts/{id}/approval-request']),
    );
  });
});
