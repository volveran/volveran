// Replay Rules on the Background Leader (#118): two Replicas run one set of Rule Passes, their
// limits survive a leader change, a new leader does not start a second pass, and a pause or
// resume through either Replica works, including during a pass. What a refused lock does on the
// broker is pinned here too: a pass skipped, naming what holds the queue.
import { afterEach, describe, expect, it } from 'vitest';
import { deadLetter, deadLetterRoutes, eventually, fixtureQueues, leaderHooks, purgeQueues, ranSummary, ruleSchedulerHooks, testProfile, withChannel } from './harness.js';
import { startTwoReplicas, type ReplicaName, type TwoReplicas } from './two-replicas.js';

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
const rulePath = `/api/profiles/dev/replay-rules/${RULE}`;
const checkoutPath = `/api/profiles/dev/vhosts/%2F/queues/${encodeURIComponent(dlq)}/checkouts`;

async function due(ids: string[]) {
  await deadLetter(route, ids.map((id) => ({ body: id, options: { messageId: id } })));
  await purgeQueues('/', route.dlqs.filter((q) => q !== dlq));
}

/** The consumer of the work queue rejects every ready Message, so the broker dead-letters them again. */
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
    return taken.map((m) => String(m.properties.messageId)).sort();
  });
}

/** Holds a Replica's Apply before its first step until released, so a test can act during a pass. */
function stepGate() {
  let reached = () => {};
  let release = () => {};
  const atStep = new Promise<void>((resolve) => (reached = resolve));
  const opened = new Promise<void>((resolve) => (release = resolve));
  return {
    atStep,
    release,
    async beforeApplyStep() {
      reached();
      await opened;
    },
  };
}

describe('Replay Rules on the Background Leader', () => {
  let replicas: TwoReplicas | undefined;
  afterEach(async () => {
    await replicas?.close();
    replicas = undefined;
    await purgeQueues('/', fixtureQueues);
  });

  const started = async ({ gate, ruleFixture = rule }: { gate?: ReturnType<typeof stepGate>; ruleFixture?: typeof rule } = {}) => {
    const at = new Date(Date.now() + 11 * MINUTE);
    const now = new Date();
    const schedulers = { a: ruleSchedulerHooks(at), b: ruleSchedulerHooks(at) };
    const leaders = { a: leaderHooks(now), b: leaderHooks(now) };
    const logs: Record<ReplicaName, Array<Record<string, any>>> = { a: [], b: [] };
    const two = await startTwoReplicas({
      profiles: [testProfile({ name: 'dev', replayRules: [ruleFixture] })],
      perReplica: (name: ReplicaName) => ({
        leaderTestHooks: leaders[name].hooks,
        logs: logs[name],
        checkoutTestHooks: { ...schedulers[name].hooks, ...(name === 'a' && gate && { beforeApplyStep: () => gate.beforeApplyStep() }) },
      }),
    });
    replicas = two;
    const browser = two.browser();
    await browser.signIn({ sub: 'ana' });
    const listed = async (replica: ReplicaName) => (await browser.to(two[replica]).get('/api/profiles/dev/replay-rules')).body.rules[0];
    /** b takes the lease from a, which is not told, and has started the rules. */
    const takeOver = async () => {
      leaders.b.advance(MINUTE);
      await leaders.b.claimNow();
      await eventually(async () => {
        expect(leaders.b.isLeader()).toBe(true);
        // Started: the scheduler answers, here that it has no such rule.
        expect(() => schedulers.b.runPass('dev', 'no-such-rule')).toThrow('no-such-rule');
      }, 5_000, 20);
    };
    return { two, schedulers, leaders, logs, browser, listed, takeOver };
  };

  it('schedules on the leader only, and shows the same next pass through either Replica', async () => {
    const { schedulers, listed } = await started();

    // b has never led: its scheduler never started.
    expect(() => schedulers.b.runPass('dev', RULE)).toThrow('No app has started');
    const nextThroughA = (await listed('a')).nextPassAt;
    expect(nextThroughA).not.toBeNull();
    expect((await listed('b')).nextPassAt).toBe(nextThroughA);
  });

  it('runs one set of passes when the timers of both Replicas reach the time', async () => {
    const { schedulers, listed } = await started();

    schedulers.a.advance(6 * MINUTE);
    schedulers.b.advance(6 * MINUTE);

    await eventually(async () => expect((await listed('b')).passes).toHaveLength(1), 10_000, 50);
    const { passes, nextPassAt } = await eventually(async () => {
      const view = await listed('b');
      expect(view.nextPassAt).not.toBeNull();
      return view;
    }, 10_000, 50);
    expect(passes).toHaveLength(1);
    expect(Date.parse(nextPassAt)).toBeGreaterThanOrEqual(Date.parse(passes[0].at) + 5 * MINUTE);
  });

  it('runs a Run now through the other Replica on the leader', async () => {
    const gate = stepGate();
    const { two, browser, listed } = await started({ gate });
    await due(['p-1']);

    const run = browser.to(two.b).post(`${rulePath}/run`);
    // Only a's Apply has the gate, so getting here means the pass is on a.
    await gate.atStep;
    gate.release();

    const answer = await run;
    expect(answer.status).toBe(200);
    expect(answer.body.pass.summary).toMatchObject({ replayed: 1 });
    expect((await listed('b')).passes).toHaveLength(1);
  });

  it('answers a Run now 503 replica_unreachable while the leader cannot be reached', async () => {
    const { two, browser } = await started();
    await two.a.crash();

    const answer = await browser.to(two.b).post(`${rulePath}/run`);

    expect(answer.status).toBe(503);
    expect(answer.body.error.code).toBe('replica_unreachable');
  });

  it('skips a pass while an Operator holds the queue through the other Replica, naming them', async () => {
    const { two, schedulers, browser, listed } = await started();
    await due(['p-1']);
    const held = await browser.to(two.b).post(checkoutPath);
    expect(held.status).toBe(201);

    const pass = await schedulers.a.runPass('dev', RULE);

    expect(pass).toMatchObject({ status: 'skipped', summary: null });
    expect(pass!.reason).toContain('already checked out');
    expect((await listed('a')).state.paused).toBe(false);
    await browser.to(two.b).request('DELETE', `/api/checkouts/${held.body.checkout.id}`);
  });

  it('carries attempts, back-off and the automatic stop on after failover', async () => {
    const { two, schedulers, listed, takeOver } = await started({ ruleFixture: { ...rule, maxAttempts: 1, stopWhen: { diedAgain: 2, within: '1h' } } });
    await due(['p-1', 'p-2']);
    expect(ranSummary(await schedulers.a.runPass('dev', RULE))).toMatchObject({ replayed: 2 });
    await rejectAll();

    await two.a.crash();
    await takeOver();
    const pass = await schedulers.b.runPass('dev', RULE);

    // The attempts of a's Replays are used up on b, and a's Replays count towards b's stop.
    expect(ranSummary(pass)).toMatchObject({ held: 2, usedUp: 2, replayed: 0 });
    const view = await listed('b');
    expect(view.state).toMatchObject({ paused: true, pausedReason: 'died_again' });
    expect(view.nextPassAt).toBeNull();
    expect(view.passes).toHaveLength(2);
  });

  it('keeps the back-off of a Message on the new leader, from when it died', async () => {
    const { two, schedulers, takeOver } = await started();
    await due(['p-1']);
    // It waits 10 minutes from its dead-lettering, whoever leads: at 5 it is not due.
    await two.a.crash();
    await takeOver();
    schedulers.b.set(new Date(Date.now() + 5 * MINUTE));
    expect(ranSummary(await schedulers.b.runPass('dev', RULE))).toMatchObject({ held: 1, notDue: 1, replayed: 0 });
  });

  it('does not start a second pass when a new leader finds one in progress', async () => {
    const gate = stepGate();
    const { schedulers, listed, takeOver } = await started({ gate });
    await due(['p-1']);
    const first = schedulers.a.runPass('dev', RULE);
    await gate.atStep;

    await takeOver();
    const second = await schedulers.b.runPass('dev', RULE);

    expect(second).toMatchObject({ status: 'skipped', summary: null });
    expect(second!.reason).toContain('already has an active Checkout');
    gate.release();
    expect(ranSummary(await first)).toMatchObject({ replayed: 1 });
    expect((await listed('b')).passes.map((p: any) => p.status).sort()).toEqual(['ran', 'skipped']);
    expect(await readyIds(route.workQueue)).toEqual(['p-1']);
  });

  it('refuses the scheduled pass of a stalled former leader, as no failure', async () => {
    const { schedulers, leaders, logs, listed, takeOver } = await started();
    await due(['p-1']);
    await takeOver();
    expect(leaders.a.isLeader()).toBe(true);

    expect(await schedulers.a.runPass('dev', RULE)).toBeNull();

    expect((await listed('b')).passes).toEqual([]);
    expect(await readyIds(dlq)).toEqual(['p-1']);
    expect(logs.a.some((l) => /no longer the Background Leader/.test(l.msg))).toBe(true);
    expect(logs.a.filter((l) => l.level >= 50)).toEqual([]);
  });

  it('starts the rules again on a Replica that leads a second time', async () => {
    const { two, schedulers, leaders, takeOver } = await started();
    await takeOver();
    await leaders.a.claimNow();
    expect(leaders.a.isLeader()).toBe(false);

    await two.b.shutdown();
    leaders.a.advance(MINUTE);
    await leaders.a.claimNow();
    expect(leaders.a.isLeader()).toBe(true);

    await eventually(async () => expect(ranSummary(await schedulers.a.runPass('dev', RULE))).toMatchObject({ held: 0 }), 5_000, 50);
  });

  it('moves the lease on a graceful stop without waiting for a pass, which still finishes and is recorded', async () => {
    const gate = stepGate();
    const { two, schedulers, leaders, listed } = await started({ gate });
    await due(['p-1']);
    const running = schedulers.a.runPass('dev', RULE);
    await gate.atStep;

    const stopping = two.a.shutdown();
    await eventually(async () => {
      await leaders.b.claimNow();
      expect(leaders.b.isLeader()).toBe(true);
    }, 10_000, 50);

    gate.release();
    expect(ranSummary(await running)).toMatchObject({ replayed: 1 });
    await stopping;
    expect((await listed('b')).passes).toMatchObject([{ status: 'ran' }]);
  });

  it('stops a pass in progress on a pause through the other Replica: the step under way finishes, the rest go back', async () => {
    const gate = stepGate();
    const { two, schedulers, browser, listed } = await started({ gate });
    await due(['p-1', 'p-2', 'p-3']);
    const running = schedulers.a.runPass('dev', RULE);
    await gate.atStep;

    const paused = await browser.to(two.b).post(`${rulePath}/pause`, { reason: 'incident' });
    expect(paused.status).toBe(200);
    gate.release();

    const pass = await running;
    expect(ranSummary(pass)).toMatchObject({ held: 3, replayed: 1, notDue: 2, failed: 0 });
    expect(pass!.reason).toContain('Stopped');
    expect(await readyIds(dlq)).toHaveLength(2);
    expect((await listed('a')).state).toMatchObject({ paused: true, pausedReason: 'incident' });
  });

  it('stops a pass that a former leader still runs, at its next look at the store', async () => {
    const gate = stepGate();
    const { two, schedulers, browser, takeOver } = await started({ gate });
    await due(['p-1', 'p-2']);
    const running = schedulers.a.runPass('dev', RULE);
    await gate.atStep;
    await takeOver();

    // Told to b, the leader, which runs no pass. a finds out by itself.
    expect((await browser.to(two.b).post(`${rulePath}/pause`, { reason: 'incident' })).status).toBe(200);
    schedulers.a.advance(5_000);
    await new Promise((resolve) => setTimeout(resolve, 500));
    gate.release();

    expect(ranSummary(await running)).toMatchObject({ replayed: 1, notDue: 1 });
  });

  it('lets a Run now of a paused rule finish, since the pause came before it', async () => {
    const gate = stepGate();
    const { two, schedulers, browser } = await started({ gate });
    await due(['p-1', 'p-2']);
    await browser.to(two.b).post(`${rulePath}/pause`, { reason: 'incident' });

    const run = browser.to(two.b).post(`${rulePath}/run`);
    await gate.atStep;
    schedulers.a.advance(5_000);
    await new Promise((resolve) => setTimeout(resolve, 200));
    gate.release();

    expect((await run).body.pass.summary).toMatchObject({ replayed: 2 });
  });

  it('pauses and resumes through either Replica, and the next pass follows on both', async () => {
    const { two, browser, listed } = await started();

    expect((await browser.to(two.b).post(`${rulePath}/pause`, { reason: 'incident' })).status).toBe(200);
    expect((await listed('a')).nextPassAt).toBeNull();
    expect((await listed('b')).nextPassAt).toBeNull();

    expect((await browser.to(two.b).post(`${rulePath}/resume`)).status).toBe(200);
    const next = (await listed('a')).nextPassAt;
    expect(next).not.toBeNull();
    expect((await listed('b')).nextPassAt).toBe(next);
  });

  it('schedules a resume the leader was never told of, at its next look at the store', async () => {
    const { two, schedulers, browser, listed } = await started();
    await browser.to(two.a).post(`${rulePath}/pause`, { reason: 'incident' });
    // Written straight to the shared store, as a resume whose forward to the leader was lost.
    await two.database.query(`UPDATE replay_rule_state SET paused = 0, paused_reason = NULL, paused_by = NULL, paused_at = NULL`);
    expect((await listed('b')).nextPassAt).toBeNull();

    schedulers.a.advance(5_000);

    await eventually(async () => expect((await listed('b')).nextPassAt).not.toBeNull(), 5_000, 50);
  });

  it('answers one of two pauses at once through the two Replicas, with one Audit Entry', async () => {
    const { two, browser } = await started();

    const answers = await Promise.all([
      browser.to(two.a).post(`${rulePath}/pause`, { reason: 'one' }),
      browser.to(two.b).post(`${rulePath}/pause`, { reason: 'two' }),
    ]);

    expect(answers.map((a) => a.status).sort()).toEqual([200, 409]);
    expect((await browser.get('/api/audit-entries?action=rule_pause')).body.entries).toHaveLength(1);
  });

  it('does not serve the leader\'s notice on the web port', async () => {
    const { two, browser } = await started();
    expect((await browser.to(two.a).post(`${rulePath}/changed`)).status).toBe(404);
  });
});
