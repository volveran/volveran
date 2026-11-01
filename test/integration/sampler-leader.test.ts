// The sampler on the Background Leader (#116): two Replicas take one set of Samples, the
// Messages taken out through the other one count in estimated arrivals, and a failover
// shows as a gap with no false arrivals. Audit Entries carry real time, so each run that
// should see them sets the sampler's clock to the wall clock first.
import { afterEach, describe, expect, it } from 'vitest';
import { delayedAuditStore } from '../support/delayed-audit-store.js';
import {
  applyAndWait,
  deadLetter,
  deadLetterRoutes,
  eventually,
  fixtureQueues,
  leaderHooks,
  management,
  purgeQueues,
  samplerHooks,
  startApp,
  testProfile,
} from './harness.js';
import { startTwoReplicas, type ReplicaBrowser, type ReplicaName, type TwoReplicas } from './two-replicas.js';

const route = deadLetterRoutes.classic;
const dlq = route.dlq;
const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;
const everything = () => `?from=${new Date(Date.now() - DAY).toISOString()}&to=${new Date(Date.now() + DAY).toISOString()}`;
const HISTORY = `/api/profiles/dev/vhosts/%2F/queues/${encodeURIComponent(dlq)}/history`;

const messages = (prefix: string, count: number) =>
  Array.from({ length: count }, (_, i) => ({ body: `${prefix}-${i}`, options: { messageId: `${prefix}-${i}` } }));

async function waitForDepth(depth: number) {
  await eventually(async () => {
    const { body } = await management(`/queues/%2F/${encodeURIComponent(dlq)}?columns=messages`);
    expect((body as { messages?: unknown }).messages).toBe(depth);
  }, 30_000, 250);
}

/** One run, again if the management API was too slow for its client on a busy machine. */
async function sample(sampler: ReturnType<typeof samplerHooks>, at = new Date()) {
  for (let attempt = 0; attempt < 3; attempt++) {
    sampler.set(at);
    const [run] = await sampler.sampleNow();
    if (run?.errorCode !== 'broker_unreachable') {
      expect(run?.errorCode).toBeNull();
      return;
    }
  }
  throw new Error('The sampling run could not reach the broker 3 times in a row');
}

async function discardThrough(browser: ReplicaBrowser, count: number): Promise<string> {
  const { checkout } = (await browser.post(`/api/profiles/dev/vhosts/%2F/queues/${encodeURIComponent(dlq)}/checkouts`)).body;
  const handles = checkout.messages.slice(0, count).map((m: any) => m.handle);
  await browser.post(`/api/checkouts/${checkout.id}/decisions`, { handles, decision: { kind: 'discard', reason: 'bad payload' } });
  expect((await applyAndWait(browser, `/api/checkouts/${checkout.id}/apply`, { confirm: true })).status).toBe(202);
  return checkout.id;
}

describe('the sampler on the Background Leader', () => {
  let replicas: TwoReplicas | undefined;
  afterEach(async () => {
    await replicas?.close();
    replicas = undefined;
    await purgeQueues('/', fixtureQueues);
  });

  /** Two Replicas on test clocks that differ, so that a run on each would be two Samples and not one written twice. */
  const started = async () => {
    const now = Date.now();
    const samplers = { a: samplerHooks(new Date(now)), b: samplerHooks(new Date(now + 1_000)) };
    const leaders = { a: leaderHooks(new Date(now)), b: leaderHooks(new Date(now)) };
    const logs: Record<ReplicaName, Array<Record<string, any>>> = { a: [], b: [] };
    const two = await startTwoReplicas({
      profiles: [testProfile({ name: 'dev' })],
      perReplica: (name) => ({ samplerTestHooks: samplers[name].hooks, leaderTestHooks: leaders[name].hooks, logs: logs[name] }),
    });
    replicas = two;
    const browser = two.browser();
    await browser.signIn({ sub: 'ana' });
    const historyThrough = async (replica: ReplicaName) => (await browser.to(two[replica]).get(`${HISTORY}${everything()}`)).body;
    return { two, samplers, leaders, logs, browser, historyThrough };
  };

  /** b takes the lease: its clock runs past a's claim. */
  const takeOver = async ({ leaders, samplers }: Pick<Awaited<ReturnType<typeof started>>, 'leaders' | 'samplers'>) => {
    leaders.b.advance(MINUTE);
    await leaders.b.claimNow();
    await eventually(async () => {
      expect(leaders.b.isLeader()).toBe(true);
      samplers.b.latest();
    }, 5_000, 20);
  };

  it('takes one set of Samples, on the timers of the leader, and either Replica shows it', async () => {
    const { samplers, historyThrough } = await started();
    await deadLetter(route, messages('one', 1));
    await waitForDepth(1);

    const beginning = samplers.a.now().getTime();
    for (let run = 1; run <= 3; run++) {
      samplers.a.advance(MINUTE);
      samplers.b.advance(MINUTE);
      await eventually(async () => expect((await historyThrough('a')).samples).toHaveLength(run), 20_000, 50);
    }
    const history = await historyThrough('b');
    expect(history.samples.map((s: any) => new Date(s.at).getTime())).toEqual([1, 2, 3].map((n) => beginning + n * MINUTE));
    expect(history.samples.map((s: any) => s.depth)).toEqual([1, 1, 1]);
    expect((await historyThrough('a')).samples).toEqual(history.samples);
  });

  it('counts Messages taken out through the Replica that is not the leader in estimated arrivals', async () => {
    const { two, samplers, leaders, browser, historyThrough } = await started();
    expect([leaders.a.isLeader(), leaders.b.isLeader()]).toEqual([true, false]);
    await deadLetter(route, messages('first', 3));
    await waitForDepth(3);
    await sample(samplers.a);

    // 2 taken out through b and 2 arrived: depth stays at 3, which alone would say none.
    const checkoutId = await discardThrough(browser.to(two.b), 2);
    await deadLetter(route, messages('second', 2));
    await waitForDepth(3);
    await sample(samplers.a);

    const history = await historyThrough('a');
    expect(history.samples.map((s: any) => [s.depth, s.estimatedArrivals])).toEqual([[3, null], [3, 2]]);
    expect(history.marks).toEqual([expect.objectContaining({ checkoutId, counts: expect.objectContaining({ discard: 2 }) })]);
  });

  it('after the leader crashes, goes on from the stored depth on the other, with a gap in the view and no false arrivals', async () => {
    const context = await started();
    const { two, samplers, browser } = context;
    await deadLetter(route, messages('first', 2));
    await waitForDepth(2);
    const before = new Date();
    await sample(samplers.a, before);

    await two.a.crash();
    await takeOver(context);
    // Taken out during the gap, through the one left: its drop is no arrival, nor its take-out.
    await discardThrough(browser.to(two.b), 1);
    await waitForDepth(1);
    const after = new Date(Date.now() + 5 * MINUTE);
    await sample(samplers.b, after);

    const history = (await browser.to(two.b).get(`${HISTORY}?from=${new Date(before.getTime() - MINUTE).toISOString()}&to=${after.toISOString()}`)).body;
    expect(history.samples.map((s: any) => [s.depth, s.estimatedArrivals])).toEqual([[2, null], [1, 0]]);
    expect(history.gaps).toEqual([{ from: before.toISOString(), to: after.toISOString(), errorCode: null }]);
  });

  it('refuses the run of a stalled former leader, as no failure, and it reaches neither the view nor its own snapshot', async () => {
    const context = await started();
    const { samplers, leaders, logs, historyThrough } = context;
    await deadLetter(route, messages('first', 1));
    await waitForDepth(1);
    await sample(samplers.a);
    const first = samplers.a.latest().profiles[0]!.lastRun;

    await takeOver(context);
    expect(leaders.a.isLeader()).toBe(true);
    samplers.a.set(new Date(Date.now() + MINUTE));
    expect(await samplers.a.sampleNow()).toEqual([]);

    expect((await historyThrough('b')).samples).toHaveLength(1);
    expect(samplers.a.latest().profiles[0]!.lastRun).toEqual(first);
    expect(logs.a.some((l) => /sampling run wrote nothing/.test(l.msg))).toBe(true);
    expect(logs.a.filter((l) => l.level >= 50)).toEqual([]);

    await leaders.a.claimNow();
    expect(leaders.a.isLeader()).toBe(false);
  });
});

describe('a single Replica on SQLite', () => {
  it('fails startup when the sampler cannot start, as before it moved onto the leader', async () => {
    await expect(
      startApp({
        profiles: [testProfile({ name: 'dev' })],
        env: { VOLVERAN_POSTGRES_URL: undefined },
        wrapAuditStore: (store) => delayedAuditStore(store, (call) => (call === 'history.lastRuns' ? Promise.reject(new Error('store broken')) : undefined)),
      }),
    ).rejects.toThrow('store broken');
  });
});
