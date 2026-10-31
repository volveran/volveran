// Alerting on a store that takes its time (ADR 0013): load, evaluate and save are
// one turn per profile, so evaluations cannot lose each other's result.
import { afterEach, describe, expect, it } from 'vitest';
import { Alerting } from '../../src/server/alerts/alerting.js';
import { AuditStore } from '../../src/server/audit/store.js';
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
  const stores: AuditStore[] = [];
  afterEach(() => {
    while (stores.length) stores.pop()!.close();
  });

  function alertingOn(calls: string[]) {
    const sync = new AuditStore();
    stores.push(sync);
    const store = delayedAuditStore(sync.async, async (call) => {
      calls.push(call);
      await new Promise((resolve) => setTimeout(resolve, 5));
    });
    const sent: unknown[] = [];
    const errors: unknown[] = [];
    const alerting = new Alerting({
      profiles,
      store: store.alerts,
      notifier: { send: async (_destination, notification) => void sent.push(notification) as never },
      clock: { now: () => AT },
      pausedReplayRules: async () => [],
      lastSuccessAt: () => AT,
      onError: (err) => errors.push(err),
    });
    return { alerting, store, sent, errors };
  }

  it('fires once when a run and a Replay Rule change evaluate the same profile at once', async () => {
    const { alerting, store, sent } = alertingOn([]);
    await Promise.all([alerting.evaluate(deepRun('prod')), alerting.evaluate(deepRun('prod')), alerting.replayRuleChanged('prod')]);
    expect(sent).toHaveLength(1);
    expect((await store.alerts.load('prod')).alerts).toEqual([expect.objectContaining({ rule: 'deep', status: 'firing' })]);
  });

  it('does not make one profile wait for another', async () => {
    const calls: string[] = [];
    const { alerting } = alertingOn(calls);
    await Promise.all([alerting.evaluate(deepRun('prod')), alerting.evaluate(deepRun('staging'))]);
    expect(calls).toEqual(['alerts.load', 'alerts.load', 'alerts.save', 'alerts.save']);
  });

  it('goes on after an evaluation that failed, and a Replay Rule change never rejects', async () => {
    const sync = new AuditStore();
    stores.push(sync);
    let failing = true;
    const store = delayedAuditStore(sync.async, () => {
      if (failing) throw new Error('store gone');
    });
    const sent: unknown[] = [];
    const errors: unknown[] = [];
    const alerting = new Alerting({
      profiles,
      store: store.alerts,
      notifier: { send: async (_destination, notification) => void sent.push(notification) as never },
      clock: { now: () => AT },
      pausedReplayRules: async () => [],
      lastSuccessAt: () => AT,
      onError: (err) => errors.push(err),
    });
    await expect(alerting.evaluate(deepRun('prod'))).rejects.toThrow('store gone');
    await expect(alerting.replayRuleChanged('prod')).resolves.toBeUndefined();
    expect(errors).toHaveLength(1);
    failing = false;
    await alerting.evaluate(deepRun('prod'));
    expect(sent).toHaveLength(1);
  });

  it('removes Alerts of rules no longer in the file at start, and evaluates nothing once stopped', async () => {
    const { alerting, store, sent } = alertingOn([]);
    await alerting.evaluate(deepRun('prod'));
    await store.alerts.save('gone', await store.alerts.load('prod'));
    await alerting.start();
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
});
