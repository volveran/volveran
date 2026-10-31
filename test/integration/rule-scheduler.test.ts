// Replay rules on their schedule, against the real broker, with the
// scheduler's test clock and "run a pass now" (ruleSchedulerHooks): passes
// over time with a growing back-off until the attempts are used up, a pass
// skipped while an Operator holds the queue, rule state kept in the audit
// store across a restart, and the rule badge on an Operator's Messages.
import { rm } from 'node:fs/promises';
import { afterEach, describe, expect, it } from 'vitest';
import {
  deadLetter,
  deadLetterRoutes,
  eventually,
  fixtureQueues,
  makeTempDir,
  purgeQueues,
  ruleSchedulerHooks,
  startApp,
  testOperator,
  testProfile,
  withChannel,
  type TestApp,
} from './harness.js';

const route = deadLetterRoutes.quorum;
const dlq = route.dlq;
const parking = 'triage.manual';
const RULE = 'transient-payments';
const MINUTE = 60_000;
const checkoutPath = `/api/profiles/local/vhosts/%2F/queues/${dlq}/checkouts`;

const rule = {
  name: RULE,
  vhost: '/',
  queue: dlq,
  every: '5m',
  backoff: { initial: '10m', multiplier: 2, max: '1h' },
  maxAttempts: 2,
  stopWhen: { diedAgain: 50, within: '15m' },
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

/** The message ids of the ready Messages of `queue`, taken and put back. */
async function readyIds(queue: string): Promise<string[]> {
  return withChannel('/', async (ch) => {
    const taken = [];
    for (;;) {
      const m = await ch.get(queue, { noAck: false });
      if (!m) break;
      taken.push(m);
    }
    for (const m of taken) ch.nack(m, false, true);
    await ch.checkQueue(queue);
    return taken.map((m) => String(m.properties.messageId));
  });
}

describe('Replay rule scheduler', () => {
  const apps: TestApp[] = [];
  const dirs: string[] = [];
  async function start(options: Parameters<typeof startApp>[0]) {
    const app = await startApp(options);
    apps.push(app);
    return app;
  }
  afterEach(async () => {
    while (apps.length) await apps.pop()!.close();
    while (dirs.length) await rm(dirs.pop()!, { recursive: true, force: true });
    await purgeQueues('/', fixtureQueues);
  });

  it('skips a scheduled pass while an Operator holds the queue, and records it as skipped', async () => {
    const scheduler = ruleSchedulerHooks();
    const app = await start({ profiles: [testProfile({ name: 'local', replayRules: [rule] })], checkoutTestHooks: scheduler.hooks });
    await deadLetter(route, [{ body: 'p-1', options: { messageId: 'p-1' } }]);
    const held = await app.post(checkoutPath);
    expect(held.status).toBe(201);

    const pass = await scheduler.runPass('local', RULE);

    expect(pass).toMatchObject({ status: 'skipped', summary: null });
    expect(pass!.reason).toContain(testOperator);
    const { passes } = await listed(app);
    expect(passes).toEqual([pass]);
    await app.delete(`/api/checkouts/${held.body.checkout.id}`);
    expect(await readyIds(dlq)).toEqual(['p-1']);
  });

  it('Replays a Message its consumer keeps rejecting on successive passes, with a growing back-off, then Keeps it', async () => {
    const t0 = new Date();
    const scheduler = ruleSchedulerHooks(t0);
    const app = await start({ profiles: [testProfile({ name: 'local', replayRules: [rule] })], checkoutTestHooks: scheduler.hooks });
    await deadLetter(route, [{ body: 'p-1', options: { messageId: 'p-1' } }]);
    const passAt = async (minutes: number) => {
      scheduler.set(new Date(t0.getTime() + minutes * MINUTE));
      return (await scheduler.runPass('local', RULE))!.summary;
    };

    // Attempt 0 waits 10 minutes from its dead-lettering.
    expect(await passAt(5)).toMatchObject({ held: 1, notDue: 1, replayed: 0 });
    expect(await passAt(11)).toMatchObject({ held: 1, replayed: 1 });
    await rejectAll();
    // Attempt 1 waits 20 minutes, from its new dead-lettering (now, give or take seconds).
    expect(await passAt(15)).toMatchObject({ held: 1, notDue: 1, replayed: 0 });
    expect(await passAt(21)).toMatchObject({ held: 1, replayed: 1 });
    await rejectAll();
    // Two attempts used: Kept from now on.
    expect(await passAt(90)).toMatchObject({ held: 1, usedUp: 1, moved: 0, replayed: 0, notDue: 0 });
    expect(await readyIds(dlq)).toEqual(['p-1']);

    const { passes } = await listed(app);
    expect(passes.map((p: any) => [p.status, p.summary.replayed])).toEqual([
      ['ran', 0],
      ['ran', 1],
      ['ran', 0],
      ['ran', 1],
      ['ran', 0],
    ]);
  });

  it('Moves a Message whose attempts are used up to the parking queue, with a Move Audit Entry naming the rule', async () => {
    const scheduler = ruleSchedulerHooks();
    const parked = { ...rule, maxAttempts: 1, whenAttemptsUsedUp: { moveTo: { queue: parking } } };
    const app = await start({ profiles: [testProfile({ name: 'local', replayRules: [parked] })], checkoutTestHooks: scheduler.hooks });
    // Died Again once already (a replay id no Audit Entry here knows): its one attempt is used.
    await deadLetter(route, [
      { body: 'used', options: { messageId: 'used', headers: { 'x-volveran-replay-id': 'sent-by-another-instance' } } },
    ]);
    await purgeQueues('/', route.dlqs.filter((q) => q !== dlq));

    const pass = await scheduler.runPass('local', RULE);

    expect(pass!.summary).toMatchObject({ held: 1, usedUp: 1, moved: 1, replayed: 0, failed: 0 });
    expect(await readyIds(dlq)).toEqual([]);
    expect(await readyIds(parking)).toEqual(['used']);
    const { entries } = (await app.get(`/api/audit-entries?rule=${RULE}`)).body;
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      action: 'move',
      outcome: 'done',
      messageId: 'used',
      operatorName: `Replay rule ${RULE}`,
      rule: RULE,
      rulePassId: pass!.id,
      destination: { queue: parking },
    });
  });

  it("shows the rule badge on a matching Message in an Operator's Checkout, with its attempts and next attempt time", async () => {
    const t0 = new Date();
    const scheduler = ruleSchedulerHooks(new Date(t0.getTime() + 11 * MINUTE));
    const app = await start({ profiles: [testProfile({ name: 'local', replayRules: [rule] })], checkoutTestHooks: scheduler.hooks });
    await deadLetter(route, [{ body: 'p-1', options: { messageId: 'p-1' } }]);
    expect((await scheduler.runPass('local', RULE))!.summary).toMatchObject({ replayed: 1 });
    await rejectAll();

    const started = await app.post(checkoutPath);
    expect(started.status).toBe(201);
    const [row] = started.body.checkout.messages;
    const { message } = (await app.get(`/api/checkouts/${started.body.checkout.id}/messages/${row.handle}`)).body;
    const decided = await app.post(`/api/checkouts/${started.body.checkout.id}/decisions`, { handles: [row.handle], decision: { kind: 'keep' } });
    await app.delete(`/api/checkouts/${started.body.checkout.id}`);

    // Attempt 1 waits 20 minutes from the Message's latest dead-lettering (its x-death time).
    const expected = {
      name: RULE,
      attempts: 1,
      maxAttempts: 2,
      usedUp: false,
      nextAttemptAt: new Date(Date.parse(message.xDeath[0].time) + 20 * MINUTE).toISOString(),
    };
    expect(row.rule).toEqual(expected);
    expect(message.rule).toEqual(expected);
    // Every response that shows the Checkout carries the badge.
    expect(decided.body.checkout.messages[0].rule).toEqual(expected);
  });

  it('runs a rule when its timer fires, every `every` plus a small jitter', async () => {
    const scheduler = ruleSchedulerHooks();
    const app = await start({ profiles: [testProfile({ name: 'local', replayRules: [rule] })], checkoutTestHooks: scheduler.hooks });
    const t0 = scheduler.now().getTime();
    const next = Date.parse((await listed(app)).nextPassAt);
    expect(next).toBeGreaterThanOrEqual(t0 + 5 * MINUTE);
    expect(next).toBeLessThanOrEqual(t0 + 5 * MINUTE + 30_000);

    scheduler.advance(6 * MINUTE);

    const ran = await eventually(async () => {
      const { passes, nextPassAt } = await listed(app);
      expect(passes).toHaveLength(1);
      return { pass: passes[0], nextPassAt };
    });
    expect(ran.pass).toMatchObject({ status: 'ran', summary: { held: 0 } });
    expect(Date.parse(ran.nextPassAt)).toBeGreaterThanOrEqual(Date.parse(ran.pass.at) + 5 * MINUTE);
  });

  it('keeps pass history and rule state across a restart on the same audit store; a startPaused rule is not run', async () => {
    const dataDir = await makeTempDir('rule-state');
    dirs.push(dataDir);
    const paused = { ...rule, name: 'paused-rule', startPaused: true };
    const profiles = [testProfile({ name: 'local', replayRules: [rule, paused] })];
    let scheduler = ruleSchedulerHooks();
    const first = await start({ profiles, dataDir, checkoutTestHooks: scheduler.hooks });
    const pass = await scheduler.runPass('local', RULE);
    expect(await scheduler.runPass('local', 'paused-rule')).toBeNull();
    await first.close();
    apps.pop();

    // `startPaused` on the running rule now changes nothing: the stored state wins.
    scheduler = ruleSchedulerHooks();
    const second = await start({
      profiles: [testProfile({ name: 'local', replayRules: [{ ...rule, startPaused: true }, paused] })],
      dataDir,
      checkoutTestHooks: scheduler.hooks,
    });
    const running = await listed(second);
    expect(running).toMatchObject({ state: { paused: false }, passes: [pass] });
    expect(running.nextPassAt).not.toBeNull();
    const stillPaused = await listed(second, 'paused-rule');
    expect(stillPaused).toMatchObject({ state: { paused: true }, passes: [], nextPassAt: null });
    expect(await scheduler.runPass('local', 'paused-rule')).toBeNull();
  });

  it('waits for a pass in progress on shutdown, and records it', async () => {
    const dataDir = await makeTempDir('rule-shutdown');
    dirs.push(dataDir);
    let release!: () => void;
    let stepHeld!: () => void;
    const held = new Promise<void>((resolve) => (stepHeld = resolve));
    const scheduler = ruleSchedulerHooks(new Date(Date.now() + 11 * MINUTE));
    const profiles = [testProfile({ name: 'local', replayRules: [rule] })];
    const app = await start({
      profiles,
      dataDir,
      checkoutTestHooks: {
        ...scheduler.hooks,
        beforeApplyStep: async () => {
          stepHeld();
          await new Promise<void>((resolve) => (release = resolve));
        },
      },
    });
    await deadLetter(route, [{ body: 'p-1', options: { messageId: 'p-1' } }]);
    await purgeQueues('/', route.dlqs.filter((q) => q !== dlq));
    const running = scheduler.runPass('local', RULE);
    await held;

    const closed = app.close();
    apps.pop();
    release();
    await closed;
    expect((await running)!.summary).toMatchObject({ replayed: 1 });

    const again = await start({ profiles, dataDir, checkoutTestHooks: ruleSchedulerHooks().hooks });
    expect((await listed(again)).passes).toMatchObject([{ status: 'ran', summary: { replayed: 1 } }]);
    expect(await readyIds(route.workQueue)).toEqual(['p-1']);
  });
});
