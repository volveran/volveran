// Replay rules stopping themselves and being paused and resumed, against the
// real broker, with the scheduler's test clock and "run a pass now"
// (ruleSchedulerHooks): the automatic stop once enough of the rule's Replays
// die again, a pause when its queue is gone or its publishes are refused,
// and pause and resume by people, with the roles they need, as Audit Entries.
import { rm } from 'node:fs/promises';
import { afterEach, describe, expect, it } from 'vitest';
import {
  closedPort,
  deadLetter,
  makeTempDir,
  deadLetterRoutes,
  fixtureQueues,
  management,
  purgeQueues,
  ruleSchedulerHooks,
  startApp,
  testProfile,
  withChannel,
  type TestApp,
} from './harness.js';
import { teamModeEnv, TestBrowser } from './oidc-provider.js';

const route = deadLetterRoutes.quorum;
const dlq = route.dlq;
const RULE = 'transient-payments';
const MINUTE = 60_000;
const rulePath = `/api/profiles/local/replay-rules/${RULE}`;

const rule = {
  name: RULE,
  vhost: '/',
  queue: dlq,
  every: '5m',
  backoff: { initial: '10m', multiplier: 1, max: '10m' },
  maxAttempts: 10,
  stopWhen: { diedAgain: 3, within: '1h' },
};

/** The rule as GET …/replay-rules lists it. */
async function listed(app: TestApp, name = RULE) {
  const { rules } = (await app.get('/api/profiles/local/replay-rules')).body;
  return rules.find((r: any) => r.rule.name === name);
}

/** The consumer of payments.work rejects every ready Message, so the broker dead-letters them into payments.dlq again. */
async function rejectAll() {
  await withChannel('/', async (ch) => {
    for (;;) {
      const m = await ch.get(route.workQueue, { noAck: false });
      if (!m) break;
      ch.nack(m, false, false);
    }
  });
  await purgeQueues('/', route.dlqs.filter((q) => q !== dlq));
}

describe('Replay rule automatic stop', () => {
  const apps: TestApp[] = [];
  async function start(options: Parameters<typeof startApp>[0]) {
    const app = await startApp(options);
    apps.push(app);
    return app;
  }
  afterEach(async () => {
    while (apps.length) await apps.pop()!.close();
    await purgeQueues('/', fixtureQueues);
  });

  it('pauses a rule whose Replays keep dying again once `stopWhen.diedAgain` is reached, with a rule_pause Audit Entry', async () => {
    const t0 = new Date();
    const scheduler = ruleSchedulerHooks(t0);
    const app = await start({ profiles: [testProfile({ name: 'local', replayRules: [rule] })], checkoutTestHooks: scheduler.hooks });
    await deadLetter(
      route,
      ['p-1', 'p-2'].map((id) => ({ body: id, options: { messageId: id } })),
    );
    await purgeQueues('/', route.dlqs.filter((q) => q !== dlq));
    const passAt = async (minutes: number) => {
      scheduler.set(new Date(t0.getTime() + minutes * MINUTE));
      return scheduler.runPass('local', RULE);
    };

    expect((await passAt(11))!.summary).toMatchObject({ replayed: 2 });
    await rejectAll();
    // Two died again: below the limit of 3, so the rule goes on.
    expect((await passAt(22))!.summary).toMatchObject({ replayed: 2 });
    expect((await listed(app)).state.paused).toBe(false);
    await rejectAll();
    // Two more: 4 within the hour.
    expect((await passAt(33))!.summary).toMatchObject({ replayed: 2 });

    const paused = await listed(app);
    expect(paused).toMatchObject({
      state: { paused: true, pausedReason: 'died_again', pausedBy: `Replay rule ${RULE}` },
      nextPassAt: null,
    });
    expect(await passAt(44)).toBeNull();
    const { entries } = (await app.get('/api/audit-entries?action=rule_pause')).body;
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      action: 'rule_pause',
      operatorName: `Replay rule ${RULE}`,
      rule: RULE,
      reason: 'died_again',
      profile: 'local',
      queue: dlq,
      messageId: null,
      message: null,
      outcome: 'done',
    });
  });

  it('pauses a rule whose queue does not exist, with reason queue_not_found', async () => {
    const scheduler = ruleSchedulerHooks();
    const missing = { ...rule, queue: 'payments.gone' };
    const app = await start({ profiles: [testProfile({ name: 'local', replayRules: [missing] })], checkoutTestHooks: scheduler.hooks });

    expect(await scheduler.runPass('local', RULE)).toMatchObject({ status: 'failed' });

    expect(await listed(app)).toMatchObject({ state: { paused: true, pausedReason: 'queue_not_found' }, nextPassAt: null });
    const { entries } = (await app.get(`/api/audit-entries?rule=${RULE}&action=rule_pause`)).body;
    expect(entries).toMatchObject([{ reason: 'queue_not_found', queue: 'payments.gone' }]);
  });

  it('pauses a rule whose broker user may not publish, with reason broker_permission_denied', async () => {
    const user = { name: 'volveran-nowrite', password: 'volveran-nowrite-pass' };
    await management(`/users/${user.name}`, { method: 'PUT', body: { password: user.password, tags: 'management' } });
    // Configure and read everything; write only the Checkout lock queues, so a Checkout starts but no Replay is published.
    await management(`/permissions/%2F/${user.name}`, { method: 'PUT', body: { configure: '.*', write: '^volveran\\.', read: '.*' } });
    try {
      const t0 = new Date();
      const scheduler = ruleSchedulerHooks(new Date(t0.getTime() + 11 * MINUTE));
      const profile = testProfile({ name: 'local', username: user.name, passwordEnv: 'VOLVERAN_TEST_PW_NOWRITE', replayRules: [rule] });
      const app = await start({ profiles: [profile], env: { VOLVERAN_TEST_PW_NOWRITE: user.password }, checkoutTestHooks: scheduler.hooks });
      await deadLetter(route, [{ body: 'p-1', options: { messageId: 'p-1' } }]);
      await purgeQueues('/', route.dlqs.filter((q) => q !== dlq));

      expect((await scheduler.runPass('local', RULE))!.summary).toMatchObject({ held: 1, replayed: 0, failed: 1 });

      expect(await listed(app)).toMatchObject({ state: { paused: true, pausedReason: 'broker_permission_denied' } });
    } finally {
      await management(`/users/${user.name}`, { method: 'DELETE' });
    }
  });

  it('does not pause for a Message it cannot Replay (no Replay origin), which it Keeps', async () => {
    const t0 = new Date();
    const scheduler = ruleSchedulerHooks(t0);
    const app = await start({ profiles: [testProfile({ name: 'local', replayRules: [rule] })], checkoutTestHooks: scheduler.hooks });
    // Put straight into the dead-letter queue: no x-death, no framework headers, so nowhere to Replay it to.
    await withChannel('/', async (ch) => {
      ch.sendToQueue(dlq, Buffer.from('orphan'), { messageId: 'orphan', persistent: true });
      await ch.waitForConfirms();
    });
    const passAt = async (minutes: number) => {
      scheduler.set(new Date(t0.getTime() + minutes * MINUTE));
      return (await scheduler.runPass('local', RULE))!.summary;
    };

    // Its back-off runs from when the first pass saw it.
    expect(await passAt(0)).toMatchObject({ held: 1, notDue: 1 });
    expect(await passAt(11)).toMatchObject({ held: 1, replayed: 0, cannotReplay: 1, failed: 0 });
    expect(await passAt(22)).toMatchObject({ held: 1, replayed: 0, cannotReplay: 1, failed: 0 });

    expect((await listed(app)).state).toMatchObject({ paused: false, pausedReason: null });
  });
});

describe('Replay rule pause and resume', () => {
  const apps: TestApp[] = [];
  const dirs: string[] = [];
  afterEach(async () => {
    while (apps.length) await apps.pop()!.close();
    while (dirs.length) await rm(dirs.pop()!, { recursive: true, force: true });
    await purgeQueues('/', fixtureQueues);
  });

  it('lets an `operator` pause and an `admin` resume, but not a viewer pause nor an `operator` resume; both are Audit Entries', async () => {
    const port = await closedPort();
    const baseUrl = `http://127.0.0.1:${port}`;
    const scheduler = ruleSchedulerHooks();
    const app = await startApp({
      profiles: [
        testProfile({ name: 'local', roles: { viewer: ['support'], operator: ['oncall'], admin: ['platform'] }, replayRules: [rule] }),
      ],
      port,
      env: teamModeEnv(baseUrl),
      checkoutTestHooks: scheduler.hooks,
    });
    apps.push(app);
    const signedIn = async (identity: { sub: string; email: string; groups: string[] }) => {
      const browser = new TestBrowser(baseUrl);
      await browser.signIn(identity);
      return browser;
    };
    const viewer = await signedIn({ sub: 'vera-sub', email: 'vera@example.com', groups: ['support'] });
    const operator = await signedIn({ sub: 'otto-sub', email: 'otto@example.com', groups: ['oncall'] });
    const admin = await signedIn({ sub: 'ada-sub', email: 'ada@example.com', groups: ['platform'] });

    const refused = await viewer.post(`${rulePath}/pause`, { reason: 'incident' });
    expect([refused.status, refused.body.error.code]).toEqual([403, 'role_required']);
    expect((await operator.post(`${rulePath}/pause`, {})).status).toBe(400);
    expect((await operator.post(`${rulePath}/resume`)).body.error).toMatchObject({ code: 'role_required', required: 'admin' });

    const paused = await operator.post(`${rulePath}/pause`, { reason: 'payments incident' });
    expect(paused.status).toBe(200);
    expect(paused.body.state).toMatchObject({ paused: true, pausedReason: 'payments incident', pausedBy: 'otto@example.com' });
    expect((await operator.post(`${rulePath}/pause`, { reason: 'again' })).body.error.code).toBe('replay_rule_paused');
    expect(await scheduler.runPass('local', RULE)).toBeNull();
    // Run now still runs a paused rule.
    expect((await admin.post(`${rulePath}/run`)).body.pass).toMatchObject({ status: 'ran' });

    const operatorResume = await operator.post(`${rulePath}/resume`);
    expect(operatorResume.status).toBe(403);
    const resumed = await admin.post(`${rulePath}/resume`);
    expect(resumed.status).toBe(200);
    expect(resumed.body.state).toMatchObject({ paused: false, pausedReason: null, pausedBy: null });
    expect((await admin.post(`${rulePath}/resume`)).body.error.code).toBe('replay_rule_running');
    expect((await viewer.get('/api/profiles/local/replay-rules')).body.rules[0].nextPassAt).not.toBeNull();

    const { entries } = (await admin.get(`/api/audit-entries?rule=${RULE}`)).body;
    expect(entries.map((e: any) => [e.action, e.operatorName, e.role, e.reason])).toEqual([
      ['rule_resume', 'ada@example.com', 'admin', null],
      ['rule_pause', 'otto@example.com', 'operator', 'payments incident'],
    ]);
  });

  it('keeps a pause across a restart on the same audit store', async () => {
    const dataDir = await makeTempDir('rule-pause');
    dirs.push(dataDir);
    const profiles = [testProfile({ name: 'local', replayRules: [rule] })];
    const first = await startApp({ profiles, dataDir, checkoutTestHooks: ruleSchedulerHooks().hooks });
    apps.push(first);
    expect((await first.post(`${rulePath}/pause`, { reason: 'consumer redeploy' })).status).toBe(200);
    await apps.pop()!.close();

    const scheduler = ruleSchedulerHooks();
    const second = await startApp({ profiles, dataDir, checkoutTestHooks: scheduler.hooks });
    apps.push(second);
    const { rules } = (await second.get('/api/profiles/local/replay-rules')).body;
    expect(rules[0]).toMatchObject({ state: { paused: true, pausedReason: 'consumer redeploy' }, nextPassAt: null });
    expect(await scheduler.runPass('local', RULE)).toBeNull();
  });
});
