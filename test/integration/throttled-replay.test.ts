// Throttled Replay through the HTTP API, against the real broker: an Apply
// given a Replay Rate starts its Replay and Move steps at least 1/rate
// apart, and paces no Discard. A Broker Profile's `replayRate` sets the
// default rate and the most an Operator may choose; an Apply that would
// outlast its Checkout at its rate is refused before it starts. Every Audit
// Entry the Apply writes records the rate.
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  appliedCheckout,
  applyAndWait,
  deadLetter,
  deadLetterRoutes,
  fixtureQueues,
  purgeQueues,
  seedMessages,
  startApp,
  testProfile,
  type TestApp,
} from './harness.js';

const route = deadLetterRoutes.classic;
const checkoutPath = (profile: string, queue: string) =>
  `/api/profiles/${profile}/vhosts/%2F/queues/${encodeURIComponent(queue)}/checkouts`;
const REPLAY = { kind: 'replay' };
const DISCARD = { kind: 'discard', reason: 'duplicate order' };

describe('Throttled Replay', () => {
  let app: TestApp;
  const open: string[] = [];

  async function startCheckout(profile: string, queue: string) {
    const res = await app.post(checkoutPath(profile, queue));
    expect(res.status).toBe(201);
    const checkout = res.body.checkout;
    open.push(checkout.id);
    return { id: checkout.id as string, handles: checkout.messages.map((m: any) => m.handle) as number[] };
  }
  const decide = (id: string, handles: number[], decision: unknown) =>
    app.post(`/api/checkouts/${id}/decisions`, { handles, decision });
  const auditEntries = async (id: string) => (await app.get(`/api/audit-entries?checkoutId=${id}`)).body.entries as any[];
  /** Milliseconds from the first to the last of these Audit Entries. */
  const spreadMs = (entries: any[]) => {
    const times = entries.map((e) => Date.parse(e.at));
    return Math.max(...times) - Math.min(...times);
  };

  /** Dead-letters `n` Messages into orders.dlq, so each can be Replayed to orders.work. */
  const deadLettered = (n: number) =>
    deadLetter(
      route,
      Array.from({ length: n }, (_, i) => ({ body: `order ${i}`, options: { messageId: `throttled-${i}` } })),
    );

  beforeAll(async () => {
    app = await startApp({
      profiles: [
        testProfile({ name: 'local' }),
        testProfile({ name: 'throttled', replayRate: { default: 10, max: 20 } }),
        testProfile({ name: 'capped', replayRate: { max: 5 } }),
      ],
      checkoutTiming: { timeLimitMs: 120_000 },
    });
  });
  afterEach(async () => {
    while (open.length) await app.delete(`/api/checkouts/${open.pop()}`);
    await purgeQueues('/', fixtureQueues);
  });
  afterAll(async () => {
    await app?.close();
  });

  it('starts 20 Replays at 10/s at least 1/10 s apart, and paces none of the Discards in the same Apply', async () => {
    await deadLettered(40);
    const { id, handles } = await startCheckout('local', route.dlq);
    const replays = handles.filter((_, i) => i % 2 === 0);
    const discards = handles.filter((_, i) => i % 2 === 1);
    await decide(id, replays, REPLAY);
    await decide(id, discards, DISCARD);

    const started = await app.post(`/api/checkouts/${id}/apply`, { confirm: true, rate: 10 });
    expect(started.status).toBe(202);
    expect(started.body.checkout.applyProgress).toMatchObject({ total: 40, rate: 10 });
    const applied = await appliedCheckout(app, id);
    expect(applied.lastApply.outcomes.filter((o: any) => o.status === 'done')).toHaveLength(40);

    const done = await auditEntries(id);
    const replayed = done.filter((e) => e.action === 'replay');
    expect(replayed).toHaveLength(20);
    expect(spreadMs(replayed)).toBeGreaterThanOrEqual(1_850);
    // Paced Discards would stretch the Apply to about 3.9 s.
    expect(spreadMs(done)).toBeLessThan(2_700);
    expect(done.map((e) => e.rate)).toEqual(Array(40).fill(10));
  });

  it("runs at the profile's default rate when the request gives none, and shows it with the estimate", async () => {
    await deadLettered(4);
    const { id, handles } = await startCheckout('throttled', route.dlq);
    const decided = await decide(id, handles.slice(0, 3), REPLAY);
    expect(decided.body.checkout.applyConfirmation).toMatchObject({
      replayRate: { default: 10, max: 20 },
      estimatedDurationMs: 300,
    });

    const applied = await applyAndWait(app, `/api/checkouts/${id}/apply`, { confirm: true });

    expect(applied.status).toBe(202);
    expect(applied.body.checkout.applyProgress.rate).toBe(10);
    expect((await auditEntries(id)).map((e) => e.rate)).toEqual([10, 10, 10]);
  });

  it('shows no estimate and records no rate for an unthrottled Apply', async () => {
    await seedMessages('/', route.dlq, 2);
    const { id, handles } = await startCheckout('local', route.dlq);
    const decided = await decide(id, handles, DISCARD);
    expect(decided.body.checkout.applyConfirmation).toMatchObject({
      replayRate: { default: null, max: null },
      estimatedDurationMs: null,
    });
    const applied = await applyAndWait(app, `/api/checkouts/${id}/apply`, { confirm: true });
    expect(applied.body.checkout.applyProgress.rate).toBeNull();
    expect((await auditEntries(id)).map((e) => e.rate)).toEqual([null, null]);
  });

  it("refuses a rate above the profile's maximum, and no rate when the profile has a maximum but no default, naming the maximum", async () => {
    await deadLettered(2);
    const throttled = await startCheckout('throttled', route.dlq);
    await decide(throttled.id, throttled.handles, REPLAY);
    const above = await app.post(`/api/checkouts/${throttled.id}/apply`, { confirm: true, rate: 50 });
    expect([above.status, above.body.error.code, above.body.error.max]).toEqual([400, 'rate_above_maximum', 20]);
    expect(above.body.error.message).toContain('20');
    await app.delete(`/api/checkouts/${open.pop()}`);

    const capped = await startCheckout('capped', route.dlq);
    await decide(capped.id, capped.handles, REPLAY);
    const unthrottled = await app.post(`/api/checkouts/${capped.id}/apply`, { confirm: true });
    expect([unthrottled.status, unthrottled.body.error.code, unthrottled.body.error.max]).toEqual([400, 'rate_above_maximum', 5]);
    expect(unthrottled.body.error.message).toContain('5');

    const allowed = await applyAndWait(app, `/api/checkouts/${capped.id}/apply`, { confirm: true, rate: 5 });
    expect(allowed.status).toBe(202);
    expect(allowed.body.checkout.applyProgress.rate).toBe(5);
  });

  it('runs a Discard-only Apply with no rate when the profile has a maximum but no default: there is nothing to pace', async () => {
    await seedMessages('/', route.dlq, 2);
    const { id, handles } = await startCheckout('capped', route.dlq);
    await decide(id, handles, DISCARD);

    const applied = await applyAndWait(app, `/api/checkouts/${id}/apply`, { confirm: true });

    expect(applied.status).toBe(202);
    expect(applied.body.checkout.applyProgress.rate).toBeNull();
    expect((await auditEntries(id)).map((e) => [e.action, e.outcome, e.rate])).toEqual([
      ['discard', 'done', null],
      ['discard', 'done', null],
    ]);
  });

  it('refuses a rate that is not a number from 0.1 to 1,000', async () => {
    await deadLettered(1);
    const { id, handles } = await startCheckout('local', route.dlq);
    await decide(id, handles, REPLAY);
    for (const rate of ['fast', 0, 0.01, 5000]) {
      const refused = await app.post(`/api/checkouts/${id}/apply`, { confirm: true, rate });
      expect([refused.status, refused.body.error.code]).toEqual([400, 'invalid_request']);
    }
  });

  it("refuses an Apply that would outlast the Checkout's time left at its rate, before it starts", async () => {
    await deadLettered(20);
    const { id, handles } = await startCheckout('local', route.dlq);
    await decide(id, handles, REPLAY);

    const refused = await app.post(`/api/checkouts/${id}/apply`, { confirm: true, rate: 0.1 });

    expect([refused.status, refused.body.error.code]).toEqual([409, 'apply_would_outlast_checkout']);
    expect(refused.body.error.neededMs).toBe(200_000);
    expect(refused.body.error.remainingMs).toBeGreaterThan(100_000);
    expect(refused.body.error.remainingMs).toBeLessThanOrEqual(120_000);
    const still = (await app.get(`/api/checkouts/${id}`)).body.checkout;
    expect([still.status, still.applyProgress]).toEqual(['active', null]);
  });
});
