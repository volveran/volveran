// "Don't cause the second incident" in the demo (site/demo/api/simulator):
// the typed queue name on the Protected Profile production, the Replay Rate,
// the Canary watched for the profile's Watch Window, and Died Again. Through
// the API the web app calls. The orders application behind orders.work
// rejects a Replay of a Message whose Failure Details name
// SQLTimeoutException (the database is still down); every other one it
// processes.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDemoApi, type DemoApi } from '../../site/demo/api/demo-api.js';
import { AuditLog, type NewAuditEntry } from '../../site/demo/api/simulator/audit-log.js';
import { diedAgain } from '../../site/demo/api/simulator/died-again.js';
import type { CheckoutView } from '../../src/shared/checkout.js';

const origin = 'https://volveran.github.io';

async function call(api: DemoApi, method: string, path: string, body?: unknown) {
  const init: RequestInit = { method, ...(body !== undefined && { body: JSON.stringify(body), headers: { 'content-type': 'application/json' } }) };
  const res = await api.handle(new Request(`${origin}/api/v1${path}`, init));
  return { status: res.status, body: (await res.json()) as Record<string, any> };
}

async function started(api: DemoApi, profile = 'production', queue = 'orders.dlq'): Promise<CheckoutView> {
  const res = await call(api, 'POST', `/profiles/${profile}/vhosts/%2F/queues/${encodeURIComponent(queue)}/checkouts`, {});
  expect(res.status).toBe(201);
  return res.body.checkout as CheckoutView;
}

async function decide(api: DemoApi, checkout: CheckoutView, handles: number[], decision: unknown) {
  const res = await call(api, 'POST', `/checkouts/${checkout.id}/decisions`, { handles, decision });
  expect(res.body.rejected).toEqual([]);
  return res.body.checkout as CheckoutView;
}

async function current(api: DemoApi, checkout: CheckoutView): Promise<CheckoutView> {
  return (await call(api, 'GET', `/checkouts/${checkout.id}`)).body.checkout as CheckoutView;
}

/** Handles 1, 4, 7, 10 and 13 of orders.dlq name SQLTimeoutException; 2 and 3 do not. */
const TIMEOUTS = [1, 4, 7, 10, 13];

afterEach(() => {
  vi.useRealTimers();
});

describe('Apply on the Protected Profile production', () => {
  it('needs the queue name typed exactly, besides the confirmation', async () => {
    const api = createDemoApi();
    const checkout = await started(api);
    await decide(api, checkout, [2], { kind: 'discard', reason: 'Duplicate' });
    expect((await current(api, checkout)).applyConfirmation).toMatchObject({ typeQueueName: true });

    expect(await call(api, 'POST', `/checkouts/${checkout.id}/apply`, { confirm: true, confirmQueueName: 'orders.DLQ' })).toEqual({
      status: 400,
      body: {
        error: {
          code: 'queue_name_confirmation_required',
          message: 'production is a Protected Profile: Apply needs the queue name typed exactly. Send { "confirmQueueName": "orders.dlq" } along with the confirmation.',
        },
      },
    });
    expect((await call(api, 'POST', `/checkouts/${checkout.id}/apply`, { confirm: true, confirmQueueName: 'orders.dlq' })).status).toBe(202);
  });

  it('is not asked for on staging', async () => {
    const api = createDemoApi();
    const checkout = await started(api, 'staging');
    await decide(api, checkout, [2], { kind: 'discard', reason: 'Duplicate' });
    expect((await current(api, checkout)).applyConfirmation).toMatchObject({ typeQueueName: false });
    expect((await call(api, 'POST', `/checkouts/${checkout.id}/apply`, { confirm: true })).status).toBe(202);
  });
});

async function auditTimes(api: DemoApi): Promise<Array<[string, string, number]>> {
  const { body } = await call(api, 'GET', '/audit-entries');
  const entries = (body.entries as Array<{ action: string; messageId: string; at: string }>).reverse();
  const t0 = new Date(entries[0]!.at).getTime();
  return entries.map((e) => [e.action, e.messageId, new Date(e.at).getTime() - t0]);
}

describe('the Replay Rate in the demo', () => {
  it('starts Replay and Move steps at least 1/rate apart and does not slow Discards down', async () => {
    vi.useFakeTimers();
    const api = createDemoApi();
    const checkout = await started(api, 'staging');
    await decide(api, checkout, [1, 5, 6], { kind: 'discard', reason: 'Duplicate' });
    await decide(api, checkout, [2, 3], { kind: 'replay' });
    await decide(api, checkout, [8], { kind: 'move', destination: { queue: 'orders.parked' } });
    expect((await call(api, 'POST', `/checkouts/${checkout.id}/apply`, { confirm: true, rate: 2 })).status).toBe(202);
    await vi.advanceTimersByTimeAsync(5_000);

    expect(await auditTimes(api)).toEqual([
      ['discard', 'ord-7d09-0001', 0],
      ['replay', 'ord-9bf8-0002', 0],
      ['replay', 'ord-bae7-0003', 500],
      ['discard', 'ord-f8c5-0005', 500],
      ['discard', 'ord-117b4-0006', 500],
      ['move', 'ord-15592-0008', 1000],
    ]);
  });

  it('runs at the profile default when the request leaves it out, and refuses a rate above the maximum', async () => {
    const api = createDemoApi();
    const checkout = await started(api);
    await decide(api, checkout, [2], { kind: 'replay' });
    expect((await current(api, checkout)).applyConfirmation.replayRate).toEqual({ default: 5, max: 50 });
    expect(await call(api, 'POST', `/checkouts/${checkout.id}/apply`, { confirm: true, confirmQueueName: 'orders.dlq', rate: 60 })).toEqual({
      status: 400,
      body: {
        error: {
          code: 'rate_above_maximum',
          message:
            '60 Messages per second is above the maximum Replay Rate of Broker Profile "production": 50 Messages per second. Choose a rate of at most 50.',
          max: 50,
        },
      },
    });
    const res = await call(api, 'POST', `/checkouts/${checkout.id}/apply`, { confirm: true, confirmQueueName: 'orders.dlq' });
    expect(res.body.checkout.applyProgress).toMatchObject({ rate: 5 });
  });

  it('refuses an Apply whose paced steps would outlast the Checkout', async () => {
    vi.useFakeTimers();
    const api = createDemoApi();
    const checkout = await started(api, 'staging');
    await decide(api, checkout, [2, 3, 5, 6, 8, 9], { kind: 'replay' });
    for (let minute = 0; minute < 29; minute++) {
      await call(api, 'POST', `/checkouts/${checkout.id}/heartbeat`);
      await vi.advanceTimersByTimeAsync(60_000);
    }
    const res = await call(api, 'POST', `/checkouts/${checkout.id}/apply`, { confirm: true, rate: 0.1 });
    expect(res).toMatchObject({ status: 409, body: { error: { code: 'apply_would_outlast_checkout', neededMs: 60_000, remainingMs: 60_000 } } });
    expect(res.body.error.message).toBe(
      'At its Replay Rate this Apply needs about 60 s, but the Checkout of "orders.dlq" in vhost "/" has 60 s left, so it would stop part way. Choose a higher rate, or Replay fewer Messages in this Checkout.',
    );
  });
});

async function depths(api: DemoApi) {
  const { body } = await call(api, 'GET', '/profiles/staging/vhosts/%2F/queues');
  return Object.fromEntries((body.queues as Array<{ name: string; approximateMessages: number }>).map((q) => [q.name, q.approximateMessages]));
}

async function applyStarted(api: DemoApi, checkout: CheckoutView, body: Record<string, unknown> = {}) {
  const confirm = checkout.protectedProfile ? { confirm: true, confirmQueueName: checkout.queue } : { confirm: true };
  const res = await call(api, 'POST', `/checkouts/${checkout.id}/apply`, { ...confirm, ...body });
  expect(res.status).toBe(202);
  return res.body.checkout as CheckoutView;
}

describe('the orders application behind orders.work in the demo', () => {
  it('dead-letters a Replay of a SQLTimeoutException Message again a few seconds later; it processes every other one', async () => {
    vi.useFakeTimers();
    const api = createDemoApi();
    const checkout = await started(api, 'staging');
    await decide(api, checkout, [1, 2], { kind: 'replay' });
    await applyStarted(api, checkout);
    await vi.advanceTimersByTimeAsync(0);
    expect(await depths(api)).toMatchObject({ 'orders.dlq': 13, 'orders.work': 0 });
    await vi.advanceTimersByTimeAsync(3_000);
    expect(await depths(api)).toMatchObject({ 'orders.dlq': 14, 'orders.work': 0 });

    const next = await started(api, 'staging');
    const again = next.messages.at(-1)!;
    expect(again).toMatchObject({
      messageId: 'ord-7d09-0001',
      originalQueue: 'orders.work',
      deadLetterReason: 'rejected',
      failureDetails: { framework: 'spring', message: expect.stringContaining('SQLTimeoutException') },
    });
    const detail = (await call(api, 'GET', `/checkouts/${next.id}/messages/${again.handle}`)).body.message;
    expect(detail.xDeath).toEqual([expect.objectContaining({ queue: 'orders.work', reason: 'rejected', count: 1, exchange: '', routingKeys: ['orders.work'] })]);
    expect(detail.headers).toMatchObject({ 'x-volveran-from': 'orders.dlq', 'x-original-exchange': '', 'x-original-routingKey': 'orders.work' });
  });
});

/** Gives `decision` to the Messages `messageIds` of a new staging Checkout of orders.dlq, Applies it and lets the orders application answer. */
async function sendOut(api: DemoApi, messageIds: string[], decision: unknown): Promise<void> {
  const checkout = await started(api, 'staging');
  const handles = checkout.messages.filter((m) => messageIds.includes(m.messageId!)).map((m) => m.handle);
  await decide(api, checkout, handles, decision);
  await applyStarted(api, checkout);
  await vi.advanceTimersByTimeAsync(5_000);
  expect((await current(api, checkout)).status).toBe('ended');
}

describe('Died Again in the demo', () => {
  it('flags a Replayed Message that died again in the next Checkout, by its replay id, with the Audit Entry that sent it out', async () => {
    vi.useFakeTimers();
    const api = createDemoApi();
    await sendOut(api, ['ord-7d09-0001', 'ord-9bf8-0002'], { kind: 'replay' });
    const [replayed] = (await call(api, 'GET', '/audit-entries?messageId=ord-7d09-0001')).body.entries;

    const next = await started(api, 'staging');
    expect(next.diedAgainCount).toBe(1);
    const flagged = next.messages.filter((m) => m.diedAgain !== null);
    expect(flagged.map((m) => [m.messageId, m.diedAgain])).toEqual([
      [
        'ord-7d09-0001',
        { replayId: replayed.replayId, count: 1, last: { auditEntryId: replayed.id, action: 'replay', at: replayed.at, operatorName: 'demo', fromQueue: 'orders.dlq' } },
      ],
    ]);
    expect((await call(api, 'POST', `/checkouts/${next.id}/matching`, { filter: [{ kind: 'died-again' }] })).body.handles).toEqual([flagged[0]!.handle]);
    expect((await call(api, 'GET', `/checkouts/${next.id}/messages/${flagged[0]!.handle}`)).body.message.diedAgain).toEqual(flagged[0]!.diedAgain);
  });

  it('counts each time it died again, following the replay ids back through the Audit Entries, whichever Decision sent it out', async () => {
    vi.useFakeTimers();
    const api = createDemoApi();
    await sendOut(api, ['ord-7d09-0001'], { kind: 'replay' });
    await sendOut(api, ['ord-7d09-0001'], { kind: 'move', destination: { queue: 'orders.work' } });
    const [moved] = (await call(api, 'GET', '/audit-entries?action=move')).body.entries;

    const next = await started(api, 'staging');
    expect(next.messages.find((m) => m.messageId === 'ord-7d09-0001')!.diedAgain).toEqual({
      replayId: moved.replayId,
      count: 2,
      last: { auditEntryId: moved.id, action: 'move', at: moved.at, operatorName: 'demo', fromQueue: 'orders.dlq' },
    });
  });
});

describe('a Canary in the demo', () => {
  it('is required on production for more than 3 Replays, and needs a Replay to be one', async () => {
    const api = createDemoApi();
    const checkout = await started(api);
    await decide(api, checkout, [5], { kind: 'discard', reason: 'Duplicate' });
    const apply = (body: Record<string, unknown>) => call(api, 'POST', `/checkouts/${checkout.id}/apply`, { confirm: true, confirmQueueName: 'orders.dlq', ...body });
    expect((await apply({ canary: true })).body.error.code).toBe('canary_needs_replay');

    await decide(api, checkout, TIMEOUTS, { kind: 'replay' });
    expect((await current(api, checkout)).applyConfirmation.canary).toMatchObject({ watchWindowMs: 15_000, requiredAbove: 3, required: true });
    expect(await apply({})).toEqual({
      status: 400,
      body: {
        error: {
          code: 'canary_required',
          message:
            'Broker Profile "production" requires a Canary for an Apply with more than 3 Replays, and this one has 5. Start it with a Canary ("canary": true or { "handle": <Message handle> }).',
          requiredAbove: 3,
        },
      },
    });
    expect((await apply({ canary: { handle: 5 } })).body.error).toMatchObject({ code: 'invalid_request' });
    expect((await apply({ canary: true })).status).toBe(202);
  });

  it('on a SQLTimeoutException Message dies again within the 15-second Watch Window; stopping leaves the rest as Keep', async () => {
    vi.useFakeTimers();
    const api = createDemoApi();
    const checkout = await started(api);
    await decide(api, checkout, TIMEOUTS, { kind: 'replay' });
    await decide(api, checkout, [2], { kind: 'discard', reason: 'Duplicate' });
    const startedAt = Date.now();
    await applyStarted(api, checkout, { canary: true });
    await vi.advanceTimersByTimeAsync(0);

    const watching = await current(api, checkout);
    expect(watching.canary).toEqual({
      handle: 1,
      messageId: 'ord-7d09-0001',
      auditEntryId: 1,
      status: 'watching',
      watchEndsAt: new Date(startedAt + 15_000).toISOString(),
      deadLetterReason: null,
      failureDetails: null,
      watchProblem: null,
    });
    expect(watching.applyProgress).toMatchObject({ phase: 'canary_watch', done: 1, remaining: 5 });
    expect((await call(api, 'GET', '/audit-entries')).body.entries).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(3_000);
    const died = await current(api, checkout);
    expect(died.canary).toMatchObject({
      status: 'died_again',
      deadLetterReason: 'rejected',
      failureDetails: { framework: 'spring', message: expect.stringContaining('SQLTimeoutException') },
    });
    expect(died.applyProgress).toMatchObject({ phase: 'canary_done', remaining: 5 });
    await vi.advanceTimersByTimeAsync(60_000);
    expect((await current(api, checkout)).status).toBe('applying');

    const stopped = await call(api, 'POST', `/checkouts/${checkout.id}/apply/stop`);
    expect(stopped.status).toBe(200);
    await vi.advanceTimersByTimeAsync(0);
    const ended = await current(api, checkout);
    expect(ended).toMatchObject({ status: 'ended', endReason: 'applied', applyProgress: { done: 1, notAttempted: 5, stoppedBy: 'demo' } });
    expect(ended.lastApply!.outcomes.filter((o) => o.status !== 'kept').map((o) => [o.handle, o.status])).toEqual([
      [1, 'done'],
      [2, 'not-attempted'],
      [4, 'not-attempted'],
      [7, 'not-attempted'],
      [10, 'not-attempted'],
      [13, 'not-attempted'],
    ]);
    expect((await call(api, 'GET', '/audit-entries')).body.entries).toEqual([
      expect.objectContaining({ id: 1, action: 'replay', canary: true, canaryOutcome: 'died_again', outcome: 'done' }),
    ]);

    const next = await started(api, 'staging');
    expect(next.heldCount).toBe(15);
    expect(next.messages.at(-1)).toMatchObject({ messageId: 'ord-7d09-0001', diedAgain: { count: 1, last: { auditEntryId: 1 } } });
    expect(next.diedAgainCount).toBe(1);
  });

  it('on any other Message is not dead-lettered within the Watch Window; continuing carries out the rest', async () => {
    vi.useFakeTimers();
    const api = createDemoApi();
    const checkout = await started(api);
    await decide(api, checkout, [2, 3, 5, 6], { kind: 'replay' });
    await applyStarted(api, checkout, { canary: { handle: 3 } });
    await vi.advanceTimersByTimeAsync(14_999);
    expect((await current(api, checkout)).canary).toMatchObject({ handle: 3, status: 'watching' });
    expect((await call(api, 'POST', `/checkouts/${checkout.id}/apply/continue`)).status).toBe(200);
    await vi.advanceTimersByTimeAsync(5_000);
    const ended = await current(api, checkout);
    expect(ended.canary).toMatchObject({ status: 'watch_cut_short' });
    expect(ended).toMatchObject({ status: 'ended', applyProgress: { done: 4, notAttempted: 0 } });
    expect(await depths(api)).toMatchObject({ 'orders.dlq': 11 });

    const again = await started(api);
    await decide(api, again, [1, 4], { kind: 'replay' });
    await applyStarted(api, again, { canary: { handle: 4 } });
    await vi.advanceTimersByTimeAsync(15_000);
    const watched = await current(api, again);
    expect(watched.canary).toMatchObject({ handle: 4, messageId: 'ord-15592-0008', status: 'not_dead_lettered', deadLetterReason: null });
    expect(watched.applyProgress).toMatchObject({ phase: 'canary_done' });
    expect((await call(api, 'GET', `/audit-entries/${watched.canary!.auditEntryId}`)).body.entry.canaryOutcome).toBe('not_dead_lettered');
  });
});

describe('the Died Again trail of a Restored Message in the demo', () => {
  function entry(action: 'replay' | 'discard' | 'restore', fields: Partial<NewAuditEntry>): NewAuditEntry {
    return {
      at: '2026-11-04T10:00:00.000Z',
      operatorId: 'demo',
      operatorName: 'demo',
      role: 'admin',
      approverId: null,
      approverName: null,
      brokerUser: 'volveran',
      profile: 'staging',
      vhost: '/',
      queue: 'orders.dlq',
      messageId: 'ord-7d09-0001',
      action,
      reason: null,
      destination: null,
      checkoutId: null,
      restoreOf: null,
      replayId: null,
      filter: null,
      messageCount: null,
      rate: null,
      rule: null,
      rulePassId: null,
      canary: false,
      message: { properties: {}, headers: {}, body: null },
      ...fields,
    };
  }

  it('follows a Restore through the headers its Discard kept', () => {
    const audit = new AuditLog();
    audit.record(entry('replay', { replayId: 'r-1' }));
    const discard = audit.record(entry('discard', { message: { properties: {}, headers: { 'x-volveran-replay-id': 'r-1' }, body: new Uint8Array([1]) } }));
    const restore = audit.record(entry('restore', { restoreOf: discard, replayId: 'r-2', at: '2026-11-04T11:00:00.000Z', message: null }));

    expect(diedAgain({ 'x-volveran-replay-id': 'r-2' }, audit)).toEqual({
      replayId: 'r-2',
      count: 2,
      last: { auditEntryId: restore, action: 'restore', at: '2026-11-04T11:00:00.000Z', operatorName: 'demo', fromQueue: 'orders.dlq' },
    });
    expect(diedAgain({ 'x-volveran-replay-id': 'unknown' }, audit)).toEqual({ replayId: 'unknown', count: 1, last: null });
    expect(diedAgain({}, audit)).toBeNull();
  });
});
