// Background work on a store that takes its time (ADR 0013), against the real
// broker: a scrape does not wait on the store, and a store call is an interleave
// point for pauses, passes and shutdown.
import { afterEach, describe, expect, it } from 'vitest';
import { delayedAuditStore } from '../support/delayed-audit-store.js';
import {
  closedPort,
  deadLetterRoutes,
  eventually,
  fixtureQueues,
  purgeQueues,
  ruleSchedulerHooks,
  samplerHooks,
  startApp,
  testProfile,
  type TestApp,
} from './harness.js';

const route = deadLetterRoutes.quorum;
const RULE = 'transient-payments';
const rulePath = `/api/profiles/local/replay-rules/${RULE}`;
const rule = {
  name: RULE,
  vhost: '/',
  queue: route.dlq,
  every: '5m',
  backoff: { initial: '1s', multiplier: 2, max: '1h' },
  maxAttempts: 5,
  stopWhen: { diedAgain: 50, within: '15m' },
};

describe('Background work on a delayed store', () => {
  const apps: TestApp[] = [];
  /** Every store call since this was emptied. */
  const calls: string[] = [];
  /** Store calls wait for this while it is set. */
  let gate: Promise<void> | null = null;

  async function start(options: Parameters<typeof startApp>[0] = {}) {
    const app = await startApp({
      profiles: [testProfile({ name: 'local', replayRules: [rule] })],
      wrapAuditStore: (store) =>
        delayedAuditStore(store, async (call) => {
          calls.push(call);
          await new Promise((resolve) => setTimeout(resolve, 10));
          await gate;
        }),
      ...options,
    });
    apps.push(app);
    return app;
  }

  afterEach(async () => {
    gate = null;
    calls.length = 0;
    while (apps.length) await apps.pop()!.close();
    await purgeQueues('/', fixtureQueues);
  });

  it('answers a scrape at once, with no store call, while the store does not answer', async () => {
    const app = await start({ env: { VOLVERAN_METRICS_PORT: String(await closedPort()) } });
    let open!: () => void;
    gate = new Promise((resolve) => (open = resolve));
    calls.length = 0;

    const startedAt = Date.now();
    const res = await fetch(app.metricsUrl!);
    const elapsed = Date.now() - startedAt;

    expect(res.status).toBe(200);
    expect(await res.text()).toContain(`volveran_replay_rule_paused{profile="local",rule="${RULE}",reason=""} 0\n`);
    expect(calls).toEqual([]);
    expect(elapsed).toBeLessThan(1_000);
    open();
  });

  it('shows what a pause changed in the next scrape', async () => {
    const app = await start({ env: { VOLVERAN_METRICS_PORT: String(await closedPort()) } });
    expect((await app.post(`${rulePath}/pause`, { reason: 'looking' })).status).toBe(200);
    expect(await (await fetch(app.metricsUrl!)).text()).toContain(`volveran_replay_rule_paused{profile="local",rule="${RULE}",reason="looking"} 1\n`);
  });

  it('lets one of two pauses at once win, with one Audit Entry', async () => {
    const app = await start();
    const answers = await Promise.all([app.post(`${rulePath}/pause`, { reason: 'one' }), app.post(`${rulePath}/pause`, { reason: 'two' })]);
    expect(answers.map((a) => a.status).sort()).toEqual([200, 409]);
    const { entries } = (await app.get('/api/audit-entries?action=rule_pause')).body;
    expect(entries).toHaveLength(1);
    expect(entries[0].outcome).toBe('done');
  });

  it('runs one scheduled pass when two come due at once', async () => {
    const scheduler = ruleSchedulerHooks();
    await start({ checkoutTestHooks: scheduler.hooks });
    const passes = await Promise.all([scheduler.runPass('local', RULE), scheduler.runPass('local', RULE)]);
    expect(passes.filter((p) => p !== null)).toHaveLength(1);
  });

  it('leaves one next pass after a pause and a resume land on a pass ending', async () => {
    const scheduler = ruleSchedulerHooks();
    const app = await start({ checkoutTestHooks: scheduler.hooks });
    const pass = scheduler.runPass('local', RULE);
    await app.post(`${rulePath}/pause`, { reason: 'looking' });
    await app.post(`${rulePath}/resume`);
    await pass;
    await eventually(async () => {
      const [listed] = (await app.get('/api/profiles/local/replay-rules')).body.rules;
      expect(listed.nextPassAt).not.toBeNull();
    });
    scheduler.advance(10 * 60_000);
    await eventually(async () => {
      const [listed] = (await app.get('/api/profiles/local/replay-rules')).body.rules;
      expect(listed.passes).toHaveLength(2);
    });
    // Had a second timer been left behind, it would have passed too.
    await new Promise((resolve) => setTimeout(resolve, 300));
    const [listed] = (await app.get('/api/profiles/local/replay-rules')).body.rules;
    expect(listed.passes).toHaveLength(2);
  });

  it('closes with sampling, a pass, a pause and retention under way, and logs no store failure', async () => {
    const logs: Array<Record<string, any>> = [];
    const scheduler = ruleSchedulerHooks();
    const sampler = samplerHooks();
    const app = await start({
      checkoutTestHooks: scheduler.hooks,
      samplerTestHooks: sampler.hooks,
      bodyRetention: { intervalMs: 20 },
      env: { VOLVERAN_METRICS_PORT: String(await closedPort()) },
      logs,
    });
    const under = [scheduler.runPass('local', RULE), sampler.sampleNow(), app.post(`${rulePath}/pause`, { reason: 'closing' })];
    await new Promise((resolve) => setTimeout(resolve, 15));
    apps.pop();
    await app.close();
    await Promise.allSettled(under);
    expect(logs.filter((l) => l.level >= 50)).toEqual([]);
  });
});
