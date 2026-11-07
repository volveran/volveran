// The demo starts where the screenshot run left the broker when it recorded
// the read-only views (scripts/screenshots/capture.sh): after its prep (on
// staging, a Checkout of orders.dlq: Discard the head, Replay the next two,
// Apply) and die-again.mjs (both Replays dead-lettered again). So the queue
// list, Alerts and the History mark tell the same story as the triage loop.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDemoApi, type DemoApi } from '../../site/demo/api/demo-api.js';
import { startingState } from '../../site/demo/api/state.js';
import type { CheckoutView } from '../../src/shared/checkout.js';
import { committedRecording } from '../support/demo-recording.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const recorded = JSON.parse(readFileSync(path.join(root, 'docs/demo/recording.json'), 'utf8'));
const origin = 'https://volveran.github.io';
const now = Date.parse('2027-03-01T12:00:00.000Z');

async function call(api: DemoApi, method: string, url: string, body?: unknown) {
  const init: RequestInit = { method, ...(body !== undefined && { body: JSON.stringify(body), headers: { 'content-type': 'application/json' } }) };
  const res = await api.handle(new Request(new URL(url, origin), init));
  return { status: res.status, body: (await res.json()) as Record<string, any> };
}

const demoApi = () => createDemoApi(startingState(committedRecording, new Date(now)), () => now);

afterEach(() => {
  vi.useRealTimers();
});

/** The Apply the screenshot run's prep made, as the recorded History of orders.dlq marks it. */
async function prepMark(api: DemoApi) {
  const history = await call(api, 'GET', '/api/v1/profiles/staging/vhosts/%2F/queues/orders.dlq/history');
  const marks = history.body.marks.filter((m: any) => m.kind === 'apply');
  expect(marks).toHaveLength(1);
  return marks[0];
}

describe('the demo at start', () => {
  it('has every queue as deep as the recorded queue list says', async () => {
    const api = demoApi();
    const live = (await call(api, 'GET', '/api/v1/profiles/staging/vhosts/%2F/queues')).body.queues;
    const depths = (rows: any[]) => Object.fromEntries(rows.map((q) => [q.name, q.approximateMessages]));
    const staging = recorded.profiles.find((p: any) => p.summary.name === 'staging').vhosts.find((v: any) => v.name === '/');
    expect(depths(live)).toEqual(depths(staging.queueList.queues));
    expect(depths(live)['orders.dlq']).toBe(14);
  });

  it("finds the Audit Entries of the History mark's Apply: one Discard and two Replays by the Operator demo", async () => {
    const api = demoApi();
    const mark = await prepMark(api);
    expect(mark).toMatchObject({ operator: 'demo', counts: { discard: 1, replay: 2, move: 0 } });
    const { status, body } = await call(api, 'GET', mark.auditUrl);
    expect(status).toBe(200);
    expect(body.entries.map((e: any) => e.action).sort()).toEqual(['discard', 'replay', 'replay']);
    for (const entry of body.entries) {
      expect(entry).toMatchObject({ profile: 'staging', queue: 'orders.dlq', operatorName: 'demo', checkoutId: mark.checkoutId, outcome: 'done', at: mark.at });
    }
  });

  it('holds the two Replayed Messages in the next Checkout as Died Again, each traced to its Replay', async () => {
    const api = demoApi();
    const mark = await prepMark(api);
    const res = await call(api, 'POST', '/api/v1/profiles/staging/vhosts/%2F/queues/orders.dlq/checkouts', { overrideConsumers: false });
    const checkout = res.body.checkout as CheckoutView;
    expect(checkout.heldCount).toBe(14);
    const died = checkout.messages.filter((m) => m.diedAgain !== null);
    expect(died.map((m) => m.messageId)).toEqual(['ord-9bf8-0002', 'ord-bae7-0003']);
    for (const m of died) {
      expect(m.diedAgain).toMatchObject({ count: 1, last: { action: 'replay', operatorName: 'demo', fromQueue: 'orders.dlq' } });
      const entry = (await call(api, 'GET', `/api/v1/audit-entries/${m.diedAgain!.last!.auditEntryId}`)).body.entry;
      expect(entry).toMatchObject({ checkoutId: mark.checkoutId, messageId: m.messageId, replayId: m.diedAgain!.replayId });
    }
  });

  it('still dead-letters a fresh Replay of a SQLTimeoutException Message again, and processes a Replay of a Died Again one', async () => {
    vi.useFakeTimers({ now });
    const api = demoApi();
    const start = await call(api, 'POST', '/api/v1/profiles/staging/vhosts/%2F/queues/orders.dlq/checkouts', { overrideConsumers: false });
    const checkout = start.body.checkout as CheckoutView;
    const timeout = checkout.messages.find((m) => m.messageId === 'ord-d9d6-0004')!;
    const died = checkout.messages.find((m) => m.messageId === 'ord-9bf8-0002')!;
    expect(timeout.failureDetails?.message).toContain('SQLTimeoutException');
    await call(api, 'POST', `/api/v1/checkouts/${checkout.id}/decisions`, { handles: [timeout.handle, died.handle], decision: { kind: 'replay' } });
    expect((await call(api, 'POST', `/api/v1/checkouts/${checkout.id}/apply`, { confirm: true })).status).toBe(202);
    await vi.advanceTimersByTimeAsync(5_000);
    const next = (await call(api, 'POST', '/api/v1/profiles/staging/vhosts/%2F/queues/orders.dlq/checkouts', { overrideConsumers: false })).body.checkout as CheckoutView;
    expect(next.heldCount).toBe(13);
    expect(next.messages.at(-1)).toMatchObject({ messageId: 'ord-d9d6-0004', diedAgain: { count: 1 } });
    expect(next.messages.some((m) => m.messageId === 'ord-9bf8-0002')).toBe(false);
  });

  it('can Restore the Discarded head of orders.dlq from the audit log', async () => {
    const api = demoApi();
    const [discard] = (await call(api, 'GET', '/api/v1/audit-entries?action=discard')).body.entries;
    expect(discard).toMatchObject({ messageId: 'ord-7d09-0001', reason: 'Duplicate of order 880210, already fulfilled' });
    const restored = await call(api, 'POST', `/api/v1/audit-entries/${discard.id}/restore`, { confirm: true, queue: 'orders.dlq' });
    expect(restored.status).toBe(200);
    const queues = (await call(api, 'GET', '/api/v1/profiles/staging/vhosts/%2F/queues?search=orders.dlq')).body.queues;
    expect(queues.find((q: any) => q.name === 'orders.dlq').approximateMessages).toBe(15);
  });
});
