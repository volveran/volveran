// What #92 left unknown about Replay Rules, pinned against the real broker: what a pass does
// when the lock queue refuses it, and what a pause does to a pass in progress.
import { afterEach, describe, expect, it } from 'vitest';
import { lockQueueName } from '../../src/server/triage/checkout-lock.js';
import { delayedAuditStore } from '../support/delayed-audit-store.js';
import { brokerUsers, connect, deadLetter, deadLetterRoutes, fixtureQueues, purgeQueues, ranSummary, ruleSchedulerHooks, startApp, testProfile, type TestApp } from './harness.js';

const route = deadLetterRoutes.classic;
const dlq = route.dlq;
const RULE = 'transient';
const MINUTE = 60_000;
const rule = {
  name: RULE,
  vhost: '/',
  queue: dlq,
  every: '5m',
  rate: 100,
  backoff: { initial: '10m', multiplier: 1, max: '10m' },
  maxAttempts: 10,
  stopWhen: { diedAgain: 50, within: '1h' },
};
const rulePath = `/api/profiles/local/replay-rules/${RULE}`;

async function listed(app: TestApp) {
  const { rules } = (await app.get('/api/profiles/local/replay-rules')).body;
  return rules.find((r: any) => r.rule.name === RULE);
}

async function due(ids: string[]) {
  await deadLetter(route, ids.map((id) => ({ body: id, options: { messageId: id } })));
  await purgeQueues('/', route.dlqs.filter((q) => q !== dlq));
}

describe('a Rule Pass the lock refuses', () => {
  const apps: TestApp[] = [];
  afterEach(async () => {
    while (apps.length) await apps.pop()!.close();
    await purgeQueues('/', fixtureQueues);
  });

  it('is skipped when the lock queue is held with no holder it can read, touches nothing, does not pause, and the next pass counts from the skip', async () => {
    const scheduler = ruleSchedulerHooks(new Date(Date.now() + 11 * MINUTE));
    const app = await startApp({ profiles: [testProfile({ name: 'local', replayRules: [rule] })], checkoutTestHooks: scheduler.hooks });
    apps.push(app);
    await due(['p-1']);
    const holder = await connect('/');
    try {
      const ch = await holder.createChannel();
      await ch.assertQueue(lockQueueName(dlq), { exclusive: true, autoDelete: true, durable: false });

      const pass = await scheduler.runPass('local', RULE);

      expect(pass).toMatchObject({ status: 'skipped', summary: null });
      expect(pass!.reason).toContain('from another Volverán instance');
      const view = await listed(app);
      expect(view.state.paused).toBe(false);
      expect(view.passes).toEqual([pass]);
      expect(Date.parse(view.nextPassAt)).toBeGreaterThanOrEqual(Date.parse(pass!.at) + 5 * MINUTE);
    } finally {
      await holder.close();
    }
    expect(ranSummary(await scheduler.runPass('local', RULE))).toMatchObject({ held: 1, replayed: 1 });
  });

  it('answers Run now with 409 checkout_in_progress, and records the skip', async () => {
    const scheduler = ruleSchedulerHooks();
    const app = await startApp({ profiles: [testProfile({ name: 'local', replayRules: [rule] })], checkoutTestHooks: scheduler.hooks });
    apps.push(app);
    const holder = await connect('/');
    try {
      const ch = await holder.createChannel();
      await ch.assertQueue(lockQueueName(dlq), { exclusive: true, autoDelete: true, durable: false });

      const res = await app.post(`${rulePath}/run`);

      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('checkout_in_progress');
      expect((await listed(app)).passes).toMatchObject([{ status: 'skipped' }]);
    } finally {
      await holder.close();
    }
  });

  it('pauses the rule with lock_not_permitted when the broker forbids the lock queue itself', async () => {
    const scheduler = ruleSchedulerHooks();
    const profile = testProfile({ name: 'local', username: brokerUsers.noLock.username, passwordEnv: 'VOLVERAN_TEST_PW_NOLOCK', replayRules: [rule] });
    const app = await startApp({ profiles: [profile], env: { VOLVERAN_TEST_PW_NOLOCK: brokerUsers.noLock.password }, checkoutTestHooks: scheduler.hooks });
    apps.push(app);

    const pass = await scheduler.runPass('local', RULE);

    expect(pass).toMatchObject({ status: 'failed', summary: null });
    expect(await listed(app)).toMatchObject({ state: { paused: true, pausedReason: 'lock_not_permitted' }, nextPassAt: null });
  });
});

describe('a pause on a single Replica', () => {
  const apps: TestApp[] = [];
  afterEach(async () => {
    while (apps.length) await apps.pop()!.close();
    await purgeQueues('/', fixtureQueues);
  });

  it('stops the pass in progress at its next step, and the rest stay in the queue', async () => {
    let reached = () => {};
    let release = () => {};
    const atStep = new Promise<void>((resolve) => (reached = resolve));
    const opened = new Promise<void>((resolve) => (release = resolve));
    const scheduler = ruleSchedulerHooks(new Date(Date.now() + 11 * MINUTE));
    const app = await startApp({
      profiles: [testProfile({ name: 'local', replayRules: [rule] })],
      checkoutTestHooks: {
        ...scheduler.hooks,
        beforeApplyStep: async () => {
          reached();
          await opened;
        },
      },
    });
    apps.push(app);
    await due(['p-1', 'p-2', 'p-3']);
    const running = scheduler.runPass('local', RULE);
    await atStep;

    expect((await app.post(`${rulePath}/pause`, { reason: 'incident' })).status).toBe(200);
    release();

    expect(ranSummary(await running)).toMatchObject({ held: 3, replayed: 1, notDue: 2, failed: 0 });
    expect((await app.get(`/api/audit-entries?rule=${RULE}&action=replay`)).body.entries).toHaveLength(1);
  });

  it('fails startup when the rules cannot start, as before they moved onto the leader', async () => {
    await expect(
      startApp({
        profiles: [testProfile({ name: 'local', replayRules: [rule] })],
        wrapAuditStore: (store) => delayedAuditStore(store, (call) => (call === 'ruleState.ensure' ? Promise.reject(new Error('store broken')) : undefined)),
      }),
    ).rejects.toThrow('store broken');
  });
});
