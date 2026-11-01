// Alerts with two Replicas (#92): what an on-call engineer is sent, and what an Operator
// sees, whichever Replica is the Background Leader and however it stops being one.
// The store's part is in the audit store contract.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { LEADER_LEASE_MS } from '../../src/server/leader/background-leader.js';
import { delayedAuditStore } from '../support/delayed-audit-store.js';
import { deadLetter, deadLetterRoutes, eventually, fixtureQueues, leaderHooks, purgeQueues, samplerHooks, startApp, testProfile } from './harness.js';
import { startFakeDestination, type FakeDestination } from './fake-destination.js';
import { startTwoReplicas, type ReplicaName, type TwoReplicas } from './two-replicas.js';

const route = deadLetterRoutes.classic;
const dlq = route.dlq;
const destinations = [{ name: 'pager', type: 'webhook', urlEnv: 'HOOK_URL' }];
const rule = { name: 'deep', destinations: ['pager'], when: { vhost: '/', queue: dlq, depthAbove: 0 } };
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
/** Long enough for what should not come to have come, and for a job to have started. */
const SETTLE_MS = 300;

describe('Alerts with two Replicas', () => {
  let destination: FakeDestination;
  let replicas: TwoReplicas | undefined;
  let samplers: Record<ReplicaName, ReturnType<typeof samplerHooks>>;
  let leaders: Record<ReplicaName, ReturnType<typeof leaderHooks>>;

  beforeAll(async () => {
    destination = await startFakeDestination();
  });
  afterAll(() => destination.close());
  beforeEach(async () => {
    destination.received.length = 0;
    destination.answerWith();
    samplers = { a: samplerHooks(), b: samplerHooks() };
    leaders = { a: leaderHooks(), b: leaderHooks() };
    await purgeQueues('/', fixtureQueues);
    replicas = await startTwoReplicas({
      profiles: [testProfile({ name: 'local', alerts: [rule] })],
      alertDestinations: destinations,
      env: { HOOK_URL: destination.url },
      perReplica: (name) => ({ samplerTestHooks: samplers[name].hooks, leaderTestHooks: leaders[name].hooks }),
    });
  });
  afterEach(async () => {
    await replicas?.close();
    replicas = undefined;
    await purgeQueues('/', fixtureQueues);
  });

  const running = () => replicas!;
  const sent = () => destination.received.map((r) => r.json);
  const expectSent = (count: number) => eventually(async () => expect(destination.received).toHaveLength(count), 10_000, 50);
  const expectNoMore = async (count: number) => {
    await pause(SETTLE_MS);
    expect(destination.received).toHaveLength(count);
  };
  /** A Sample on a Replica that samples; one the Background Leader's job has not started has nothing to do. */
  const sampleOn = async (name: ReplicaName) => {
    try {
      await samplers[name].sampleNow();
    } catch (err) {
      if (!(err as Error).message.includes('No app has started')) throw err;
    }
  };
  const waitForDepth = async (depth: number) => {
    const browser = await signedIn();
    await eventually(async () => {
      const { body } = await browser.get('/api/profiles/local/vhosts/%2F/queues');
      expect(body.queues.find((q: any) => q.name === dlq)?.approximateMessages).toBe(depth);
    }, 30_000, 250);
  };
  const fill = async () => {
    await deadLetter(route, [{ body: 'deep', options: { messageId: 'deep' } }]);
    await waitForDepth(1);
  };
  const signedIn = async () => {
    const browser = running().browser();
    await browser.signIn({ sub: 'ana' });
    return browser;
  };
  /** The other Replica takes the lease once it has run out: `a` never renews on its clock. */
  const takeOver = async () => {
    leaders.b.advance(LEADER_LEASE_MS + 60_000);
    await leaders.b.claimNow();
    expect(leaders.b.isLeader()).toBe(true);
    await pause(SETTLE_MS);
  };

  it('sends one notification per Alert, from the leader, whichever Replicas sample', async () => {
    await fill();
    await Promise.all([sampleOn('a'), sampleOn('b')]);
    await expectSent(1);
    await Promise.all([sampleOn('a'), sampleOn('b')]);
    await expectNoMore(1);
    expect(sent()[0]).toMatchObject({ status: 'firing', rule: 'deep', queue: dlq });
  });

  it('keeps a firing Alert through a crash of the leader, not sent again as new, and resolves it from the new leader', async () => {
    await fill();
    await sampleOn('a');
    await expectSent(1);
    const { alertId } = sent()[0];
    await pause(SETTLE_MS);

    await running().a.crash();
    await takeOver();
    await sampleOn('b');
    await expectNoMore(1);
    const browser = await signedIn();
    const { body } = await browser.to(running().b).get('/api/alerts');
    expect(body.alerts).toEqual([expect.objectContaining({ alertId, status: 'firing' })]);

    await purgeQueues('/', fixtureQueues);
    await waitForDepth(0);
    await sampleOn('b');
    samplers.b.advance(60_000);
    await sampleOn('b');
    await expectSent(2);
    expect(sent()[1]).toMatchObject({ status: 'resolved', alertId });
  });

  it('sends again, from the new leader, a notification in flight when the leader crashed', async () => {
    await fill();
    // The former leader is on its retries when it goes.
    destination.answerWith(500, 500, 500);
    await sampleOn('a');
    await expectSent(1);
    const { alertId } = sent()[0];
    await running().a.crash();

    await takeOver();

    // Recorded, so by the new leader: the former one has no way to its store any more.
    const browser = await signedIn();
    await eventually(async () => {
      const { body } = await browser.to(running().b).get('/api/alerts');
      expect(body.notifications).toEqual([expect.objectContaining({ alertId, status: 'firing', outcome: 'delivered' })]);
    }, 15_000, 100);
    // It takes the same Alert forward, and starts no new one.
    await sampleOn('b');
    expect(new Set(sent().map((n) => n.alertId))).toEqual(new Set([alertId]));
  });

  it('refuses the Alert state of a stalled former leader, and it sends nothing', async () => {
    await takeOver();
    // `a` still thinks it leads: nothing has told it otherwise.
    expect(leaders.a.isLeader()).toBe(true);

    await fill();
    await sampleOn('a');
    await expectNoMore(0);
    const browser = await signedIn();
    expect((await browser.get('/api/alerts')).body.alerts).toEqual([]);

    await sampleOn('b');
    await expectSent(1);
    expect((await browser.get('/api/alerts')).body.alerts).toEqual([expect.objectContaining({ status: 'firing' })]);
  });

  it('sends a test notification and shows Alerts on either Replica', async () => {
    await fill();
    await sampleOn('a');
    await expectSent(1);
    const { alertId } = sent()[0];
    const browser = await signedIn();

    for (const replica of [running().a, running().b]) {
      const before = destination.received.length;
      const { status, body } = await browser.to(replica).post('/api/alert-destinations/pager/test');
      expect(status).toBe(200);
      expect(body.delivery).toMatchObject({ outcome: 'delivered', test: true });
      expect(destination.received).toHaveLength(before + 1);

      const alerts = (await browser.to(replica).get('/api/alerts')).body;
      expect(alerts.alerts).toEqual([expect.objectContaining({ alertId, status: 'firing' })]);
      expect(alerts.notifications.filter((n: any) => n.alertId === alertId)).toHaveLength(1);
      expect((await browser.to(replica).get('/api/profiles/local/alert-rules')).body.rules).toEqual([expect.objectContaining({ name: 'deep' })]);
    }
  });
});

describe('Alerting that cannot start', () => {
  it('fails the startup of a Replica that is the leader, as it always has', async () => {
    await expect(
      startApp({
        profiles: [testProfile({ name: 'local', alerts: [rule] })],
        alertDestinations: destinations,
        env: { HOOK_URL: 'http://127.0.0.1:1/hook' },
        wrapAuditStore: (store) =>
          delayedAuditStore(store, (call) => {
            if (call === 'alerts.keepOnly') throw new Error('store gone');
          }),
      }),
    ).rejects.toThrow();
  });
});
