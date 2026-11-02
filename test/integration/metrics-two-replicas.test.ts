// Metrics with two Replicas (#92): a dashboard summing them shows the right numbers. What
// describes shared state comes from the Background Leader alone, whichever that is; what a
// process counts comes from each; and partial failure can be alerted on.
import { afterEach, describe, expect, it } from 'vitest';
import { delayedAuditStore } from '../support/delayed-audit-store.js';
import { closedPort, deadLetter, deadLetterRoutes, eventually, fixtureQueues, leaderHooks, purgeQueues, samplerHooks, testProfile, type StartAppOptions } from './harness.js';
import { startTwoReplicas, type Replica, type ReplicaName, type TwoReplicas } from './two-replicas.js';

const route = deadLetterRoutes.classic;
const dlq = route.dlq;
const RULE = 'transient';
const rulePath = `/api/profiles/dev/replay-rules/${RULE}`;
const MINUTE = 60_000;
const depthSeries = `volveran_dead_letter_queue_messages{profile="dev",vhost="/",queue="${dlq}"}`;
const arrivalsSeries = `volveran_dead_letter_queue_estimated_arrived_messages_total{profile="dev",queue="${dlq}",vhost="/"}`;

const SHARED_STATE = [
  'volveran_dead_letter_queue_messages',
  'volveran_dead_letter_queue_setup_warnings',
  'volveran_sampling_up',
  'volveran_sampling_last_success_timestamp_seconds',
  'volveran_alerts_firing',
  'volveran_replay_rule_paused',
  'volveran_audit_store_body_bytes',
];

async function scrape(replica: Replica): Promise<string> {
  const res = await fetch(replica.metricsUrl!);
  expect(res.status).toBe(200);
  return res.text();
}

/** The families in `names` that have a series in a scrape. */
const withSeries = (text: string, names: string[]) => names.filter((name) => text.split('\n').some((line) => line.startsWith(`${name} `) || line.startsWith(`${name}{`)));

describe('metrics with two Replicas', () => {
  let replicas: TwoReplicas | undefined;
  afterEach(async () => {
    await replicas?.close();
    replicas = undefined;
    await purgeQueues('/', fixtureQueues);
  });

  const started = async (perReplica: (name: ReplicaName) => Pick<StartAppOptions, 'wrapAuditStore'> = () => ({})) => {
    const now = Date.now();
    const samplers = { a: samplerHooks(new Date(now)), b: samplerHooks(new Date(now + 1_000)) };
    const leaders = { a: leaderHooks(new Date(now)), b: leaderHooks(new Date(now)) };
    const ports = { a: await closedPort(), b: await closedPort() };
    const two = await startTwoReplicas({
      profiles: [
        testProfile({
          name: 'dev',
          replayRules: [{ name: RULE, vhost: '/', queue: dlq, every: '5m', backoff: { initial: '10m', multiplier: 1, max: '10m' }, maxAttempts: 10, stopWhen: { diedAgain: 50, within: '1h' } }],
          alerts: [{ name: 'deep', destinations: ['pager'], when: { vhost: '/', queue: dlq, depthAbove: 100 } }],
        }),
      ],
      alertDestinations: [{ name: 'pager', type: 'webhook', urlEnv: 'HOOK_URL' }],
      env: { HOOK_URL: 'http://127.0.0.1:9/hook' },
      perReplica: (name) => ({
        samplerTestHooks: samplers[name].hooks,
        leaderTestHooks: leaders[name].hooks,
        env: { VOLVERAN_METRICS_PORT: String(ports[name]) },
        ...perReplica(name),
      }),
    });
    replicas = two;
    const browser = two.browser();
    await browser.signIn({ sub: 'ana' });
    return { two, samplers, leaders, browser };
  };

  it('shows shared state from the leader only, and which Replica that is', async () => {
    const { two, samplers, leaders } = await started();
    expect([leaders.a.isLeader(), leaders.b.isLeader()]).toEqual([true, false]);
    await samplers.a.sampleNow();
    await eventually(async () => expect(withSeries(await scrape(two.a), SHARED_STATE)).toEqual(SHARED_STATE));

    const leader = await scrape(two.a);
    const other = await scrape(two.b);
    expect(withSeries(other, SHARED_STATE)).toEqual([]);
    expect(leader).toContain('volveran_background_leader 1\n');
    expect(other).toContain('volveran_background_leader 0\n');
    // What each process holds or counts is its own, so a sum is right.
    for (const text of [leader, other]) {
      expect(text).toContain('volveran_checkouts_active 0\n');
      expect(text).toContain('volveran_approvals_waiting 0\n');
    }
  });

  it('moves shared state with the lease: a former leader shows none, and the new one shows it', async () => {
    const { two, samplers, leaders, browser } = await started();
    await samplers.a.sampleNow();
    expect(await scrape(two.a)).toContain(depthSeries);
    expect((await browser.to(two.a).post(`${rulePath}/pause`, { reason: 'looking' })).status).toBe(200);

    // b's clock runs past a's claim, and a finds out at its next.
    leaders.b.advance(MINUTE);
    await leaders.b.claimNow();
    await leaders.a.claimNow();
    await eventually(async () => {
      expect(leaders.a.isLeader()).toBe(false);
      samplers.b.latest();
    }, 5_000, 20);

    await eventually(async () => {
      const newLeader = await scrape(two.b);
      expect(newLeader).toContain('volveran_background_leader 1\n');
      expect(newLeader).toContain(`volveran_replay_rule_paused{profile="dev",rule="${RULE}",reason="looking"} 1\n`);
      expect(newLeader).toContain('volveran_alerts_firing{profile="dev",rule="deep"} 0\n');
      expect(withSeries(newLeader, ['volveran_audit_store_body_bytes'])).toHaveLength(1);
    }, 5_000, 20);
    const former = await scrape(two.a);
    expect(former).toContain('volveran_background_leader 0\n');
    expect(withSeries(former, SHARED_STATE)).toEqual([]);

    // A queue's depth waits for the new leader's first run.
    expect(await scrape(two.b)).not.toContain(depthSeries);
    await samplers.b.sampleNow();
    expect(await scrape(two.b)).toContain(depthSeries);
  });

  it('keeps a counter on the Replica that counted, when the lease moves', async () => {
    const { two, samplers, leaders } = await started();
    const arrivals = (text: string) => text.split('\n').find((line) => line.startsWith(arrivalsSeries));
    // The management API can still show what an earlier test purged for about 5 s. A depth
    // that high as the Sample before would hide the arrival, so wait until the queue reads empty.
    await eventually(async () => {
      samplers.a.advance(MINUTE);
      await samplers.a.sampleNow();
      const sampled = samplers.a.latest().profiles[0]?.queues.find((q) => q.queue === dlq);
      expect(sampled?.depth).toBe(0);
    }, 20_000, 500);
    await deadLetter(route, [{ body: 'one', options: { messageId: 'one' } }]);
    let counted: string | undefined;
    await eventually(async () => {
      samplers.a.advance(MINUTE);
      await samplers.a.sampleNow();
      counted = arrivals(await scrape(two.a));
      expect(Number(counted?.split(' ')[1])).toBeGreaterThan(0);
    }, 20_000, 500);

    leaders.b.advance(MINUTE);
    await leaders.b.claimNow();
    await leaders.a.claimNow();
    await eventually(async () => expect(leaders.a.isLeader()).toBe(false), 5_000, 20);
    expect(arrivals(await scrape(two.a))).toBe(counted);
    // b has counted nothing.
    expect(arrivals(await scrape(two.b))).toBeUndefined();
  });

  it('counts a request and a notice that could not reach a Replica that has gone', async () => {
    const { two, browser } = await started();
    const start = await browser.to(two.a).post(`/api/profiles/dev/vhosts/%2F/queues/${encodeURIComponent(dlq)}/checkouts`);
    expect(start.status).toBe(201);
    await two.a.crash();

    expect((await browser.to(two.b).get(`/api/checkouts/${start.body.checkout.id}`)).status).toBe(503);
    expect(await scrape(two.b)).toContain('volveran_forwarding_failures_total{reason="unreachable"} 1\n');

    // Written where it arrives, and the leader cannot be told: fine for the Operator, and still one to see.
    expect((await browser.to(two.b).post(`${rulePath}/pause`, { reason: 'looking' })).status).toBe(200);
    expect(await scrape(two.b)).toContain('volveran_forwarding_failures_total{reason="unreachable"} 2\n');
  });

  it('counts a request with no Replica to go to', async () => {
    const { two, browser } = await started();
    // a gives the lease up, and b claims only when its test clock says so.
    await two.a.shutdown();
    expect((await browser.to(two.b).post(`${rulePath}/run`)).status).toBe(503);
    expect(await scrape(two.b)).toContain('volveran_forwarding_failures_total{reason="no_address"} 1\n');
  });

  it('counts what the internal port refuses, on the Replica that refused it', async () => {
    const { two } = await started();
    const res = await fetch(`${two.a.forwardingUrl}/api/session`, { headers: { authorization: 'Bearer not-the-secret' } });
    expect(res.status).toBe(401);
    expect(await scrape(two.a)).toContain('volveran_forwarding_failures_total{reason="refused"} 1\n');
    expect(await scrape(two.b)).not.toContain('volveran_forwarding_failures_total{');
  });

  it('counts store errors per Replica', async () => {
    let down = false;
    const { two } = await started((name) => ({
      wrapAuditStore: name === 'b' ? (store) => delayedAuditStore(store, (call) => (down && call === 'ping' ? Promise.reject(new Error('store broken')) : undefined)) : undefined,
    }));
    const errors = ['volveran_audit_store_errors_total'];
    expect(withSeries(await scrape(two.b), errors)).toEqual([]);
    down = true;
    expect((await two.b.get('/readyz')).status).toBe(503);
    expect(await scrape(two.b)).toContain('volveran_audit_store_errors_total 1\n');
    expect(withSeries(await scrape(two.a), errors)).toEqual([]);
    down = false;
  });

  it('answers a scrape on either Replica with no store call, while the store does not answer', async () => {
    let gate: Promise<void> | null = null;
    const calls: Record<ReplicaName, string[]> = { a: [], b: [] };
    const { two } = await started((name) => ({
      wrapAuditStore: (store) =>
        delayedAuditStore(store, (call) => {
          calls[name].push(call);
          return gate ?? undefined;
        }),
    }));
    let open!: () => void;
    gate = new Promise((resolve) => (open = resolve));
    calls.a.length = 0;
    calls.b.length = 0;
    const startedAt = Date.now();
    await Promise.all([scrape(two.a), scrape(two.b)]);
    expect(Date.now() - startedAt).toBeLessThan(1_000);
    expect(calls).toEqual({ a: [], b: [] });
    gate = null;
    open();
  });
});
