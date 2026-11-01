// Alerting on a store that takes its time (ADR 0013): load, evaluate and save are
// one turn per profile, so evaluations cannot lose each other's result. And as a job on
// the Background Leader (ADR 0014): it works only between start and stop, and starts again.
import { afterEach, describe, expect, it } from 'vitest';
import { Alerting } from '../../src/server/alerts/alerting.js';
import type { Notification } from '../../src/server/alerts/payloads.js';
import { testNotification } from '../../src/server/alerts/payloads.js';
import type { LeaseFence } from '../../src/server/audit/audit-store.js';
import { SqliteAuditStore } from '../../src/server/audit/sqlite-audit-store.js';
import type { FinishedRun } from '../../src/server/history/sampler.js';
import { parseProfilesFile } from '../../src/server/profiles.js';
import { delayedAuditStore } from '../support/delayed-audit-store.js';

const AT = new Date('2026-10-30T10:00:00.000Z');
const profile = (name: string) => ({
  name,
  managementUrl: 'http://localhost:15672',
  amqpUrl: 'amqp://localhost:5672',
  username: 'guest',
  passwordEnv: 'PW',
  vhosts: ['/'],
  alerts: [{ name: 'deep', destinations: ['ops'], when: { vhost: '/', queue: 'a.dlq', depthAbove: 1 } }],
});
const { profiles } = parseProfilesFile(
  JSON.stringify({ alertDestinations: [{ name: 'ops', type: 'slack', urlEnv: 'URL' }], profiles: [profile('prod'), profile('staging')] }),
  { URL: 'https://hooks.example/x', PW: 'x' },
);
const deepRun = (name: string): FinishedRun => ({
  samplingRun: { profile: name, at: AT, ok: true, errorCode: null },
  samples: [{ profile: name, vhost: '/', queue: 'a.dlq', at: AT, depth: 5, previousDepth: 5, takenOut: 0, estimatedArrivals: 0, setupWarnings: [] }],
  unknownDepth: [],
});

describe('Alerting on a delayed store', () => {
  const stores: SqliteAuditStore[] = [];
  afterEach(async () => {
    while (stores.length) await stores.pop()!.close();
  });

  /** Alerting on a store of its own, not started. `delay` runs before each store call, and may reject it. */
  function alertingOn(delay: (call: string) => Promise<void> | void, send?: (notification: Notification) => Promise<{ error: string | null }>) {
    const sqlite = new SqliteAuditStore();
    stores.push(sqlite);
    const store = delayedAuditStore(sqlite, delay);
    const sent: Notification[] = [];
    const errors: unknown[] = [];
    let leaseLost = 0;
    const alerting = new Alerting({
      profiles,
      store: store.alerts,
      notifier: {
        send: async (_destination, notification) => {
          sent.push(notification);
          return ((await send?.(notification)) ?? { error: null }) as never;
        },
      },
      clock: { now: () => AT },
      pausedReplayRules: async () => [],
      lastSuccessAt: () => AT,
      onError: (err) => errors.push(err),
      onLeaseLost: () => (leaseLost += 1),
    });
    const claim = async (holder: string, now = 1): Promise<LeaseFence> => (await sqlite.leaderLease.claim(holder, now, 1000))!;
    return { alerting, store, sent, errors, claim, leaseLost: () => leaseLost };
  }

  const slowly = (calls: string[] = []) => async (call: string) => {
    calls.push(call);
    await new Promise((resolve) => setTimeout(resolve, 5));
  };

  /** Started on a lease of its own, the way a leader starts it. */
  async function started(calls: string[] = []) {
    const on = alertingOn(slowly(calls));
    await on.alerting.start(await on.claim('me'));
    calls.length = 0;
    return on;
  }

  it('fires once when a run and a Replay Rule change evaluate the same profile at once', async () => {
    const { alerting, store, sent } = await started();
    await Promise.all([alerting.evaluate(deepRun('prod')), alerting.evaluate(deepRun('prod')), alerting.replayRuleChanged('prod')]);
    expect(sent).toHaveLength(1);
    expect((await store.alerts.load('prod')).alerts).toEqual([expect.objectContaining({ rule: 'deep', status: 'firing' })]);
  });

  it('does not make one profile wait for another', async () => {
    const calls: string[] = [];
    const { alerting } = await started(calls);
    await Promise.all([alerting.evaluate(deepRun('prod')), alerting.evaluate(deepRun('staging'))]);
    expect(calls).toEqual(['alerts.load', 'alerts.load', 'alerts.save', 'alerts.save', 'alerts.ended', 'alerts.ended']);
  });

  it('goes on after an evaluation that failed, and a Replay Rule change never rejects', async () => {
    let failing = false;
    const { alerting, sent, errors, claim } = alertingOn(() => {
      if (failing) throw new Error('store gone');
    });
    await alerting.start(await claim('me'));
    failing = true;
    await expect(alerting.evaluate(deepRun('prod'))).rejects.toThrow('store gone');
    await expect(alerting.replayRuleChanged('prod')).resolves.toBeUndefined();
    expect(errors).toHaveLength(1);
    failing = false;
    await alerting.evaluate(deepRun('prod'));
    expect(sent).toHaveLength(1);
  });

  it('removes Alerts of rules no longer in the file at start, and evaluates nothing once stopped', async () => {
    const { alerting, store, sent, claim } = await started();
    await alerting.evaluate(deepRun('prod'));
    await store.alerts.save('gone', await store.alerts.load('prod'));
    await alerting.start(await claim('me'));
    expect((await store.alerts.load('gone')).alerts).toEqual([]);
    sent.length = 0;
    await store.alerts.save('prod', { alerts: [], arrivals: [] });
    const during = alerting.evaluate(deepRun('prod'));
    await alerting.stop();
    expect(sent).toHaveLength(1);
    await during;
    await alerting.evaluate(deepRun('staging'));
    expect(sent).toHaveLength(1);
  });

  it('evaluates nothing before it starts: a Replica that is not the leader sends nothing and writes nothing', async () => {
    const { alerting, store, sent } = alertingOn(() => {});
    await alerting.evaluate(deepRun('prod'));
    await alerting.replayRuleChanged('prod');
    expect(sent).toEqual([]);
    expect((await store.alerts.load('prod')).alerts).toEqual([]);
  });

  it('starts again after a stop, in a new term', async () => {
    const { alerting, sent, claim, store } = alertingOn(() => {});
    const first = await claim('me');
    await alerting.start(first);
    await alerting.stop();
    await store.leaderLease.release('me');
    await alerting.start(await claim('me', 2));
    await alerting.evaluate(deepRun('prod'));
    expect(sent).toHaveLength(1);
  });

  it('sends nothing for a result the store refuses from a former leader, and calls that no failure', async () => {
    const { alerting, store, sent, errors, claim, leaseLost } = alertingOn(() => {});
    await alerting.start(await claim('me'));
    await store.leaderLease.release('me');
    await claim('other', 2);

    await alerting.evaluate(deepRun('prod'));
    await alerting.replayRuleChanged('prod');

    expect(sent).toEqual([]);
    expect((await store.alerts.load('prod')).alerts).toEqual([]);
    expect(errors).toEqual([]);
    expect(leaseLost()).toBe(2);
  });

  it('treats a lease lost while starting as no failure', async () => {
    const { alerting, store, claim, leaseLost } = alertingOn(() => {});
    const stale = await claim('me');
    await store.leaderLease.release('me');
    await expect(alerting.start(stale)).resolves.toBeUndefined();
    expect(() => alerting.throwStartFailure()).not.toThrow();
    expect(leaseLost()).toBe(1);
  });

  it('after a failed start says so, still evaluates, and first does what the start could not', async () => {
    let failing = true;
    const { alerting, store, sent, claim } = alertingOn((call) => {
      if (failing && call === 'alerts.keepOnly') throw new Error('store gone');
    });
    await store.alerts.save('gone', { alerts: [], arrivals: [{ vhost: '/', queue: 'q', unsettled: 1, recent: [] }] });

    await expect(alerting.start(await claim('me'))).rejects.toThrow('store gone');
    expect(() => alerting.throwStartFailure()).toThrow('store gone');

    await expect(alerting.evaluate(deepRun('prod'))).rejects.toThrow('store gone');
    expect(sent).toEqual([]);

    failing = false;
    await alerting.evaluate(deepRun('prod'));
    expect(sent).toHaveLength(1);
    expect((await store.alerts.load('gone')).arrivals).toEqual([]);
  });

  describe('what a former leader left unsent', () => {
    const deep = (status: 'firing' | 'resolved'): Notification => ({ ...testNotification(AT, 'left-over'), test: false, rule: 'deep', profile: 'prod', status });

    it('sends it at start, and then forgets it', async () => {
      const { alerting, store, sent, claim } = alertingOn(() => {});
      await store.alerts.save('prod', { alerts: [], arrivals: [] }, [{ destination: 'ops', notification: deep('resolved') }]);

      await alerting.start(await claim('me'));
      await alerting.stop();
      await alerting.drained();

      expect(sent).toEqual([deep('resolved')]);
      expect(await store.alerts.unsent()).toEqual([]);
    });

    it('forgets it quietly when its rule has left the file', async () => {
      const { alerting, store, sent, claim } = alertingOn(() => {});
      await store.alerts.save('prod', { alerts: [], arrivals: [] }, [{ destination: 'ops', notification: { ...deep('firing'), rule: 'removed' } }]);

      await alerting.start(await claim('me'));

      expect(sent).toEqual([]);
      expect(await store.alerts.unsent()).toEqual([]);
    });

    it('keeps one the server cut short for the next leader', async () => {
      const { alerting, store, sent, claim } = alertingOn(() => {}, async () => ({ error: 'server_stopping' }));
      await alerting.start(await claim('me'));
      await alerting.evaluate(deepRun('prod'));
      await alerting.drained();

      expect(sent).toHaveLength(1);
      expect(await store.alerts.unsent()).toHaveLength(1);
    });

    it('forgets one that failed after its attempts, as nothing retries a failure today', async () => {
      const { alerting, store, claim } = alertingOn(() => {}, async () => ({ error: 'timeout' }));
      await alerting.start(await claim('me'));
      await alerting.evaluate(deepRun('prod'));
      await alerting.drained();

      expect(await store.alerts.unsent()).toEqual([]);
    });

    it('does not send again what this process is still sending when the lease comes back to it', async () => {
      let finish = (_: { error: null }) => {};
      const { alerting, store, sent, claim } = alertingOn(() => {}, () => new Promise((resolve) => (finish = resolve)));
      await alerting.start(await claim('me'));
      await alerting.evaluate(deepRun('prod'));
      await alerting.stop();
      await store.leaderLease.release('me');

      await alerting.start(await claim('me', 2));
      expect(sent).toHaveLength(1);

      finish({ error: null });
      await alerting.drained();
      expect(await store.alerts.unsent()).toEqual([]);
    });
  });
});
