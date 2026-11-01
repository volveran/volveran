// Replay Rules across two Replicas. For now this pins how they behave before moving onto the
// Background Leader (#118): each Replica schedules on its own.
import { afterEach, describe, expect, it } from 'vitest';
import { deadLetter, deadLetterRoutes, fixtureQueues, purgeQueues, ranSummary, ruleSchedulerHooks, testProfile } from './harness.js';
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

/** Holds a Replica's Apply before each step until released, so a test can act during a pass. */
function stepGate() {
  let open = false;
  let reached = () => {};
  let release = () => {};
  const atStep = new Promise<void>((resolve) => (reached = resolve));
  const opened = new Promise<void>((resolve) => (release = resolve));
  return {
    atStep,
    release() {
      open = true;
      release();
    },
    async beforeApplyStep() {
      reached();
      if (!open) await opened;
    },
  };
}

describe('Replay Rules on two Replicas', () => {
  let replicas: TwoReplicas | undefined;
  afterEach(async () => {
    await replicas?.close();
    replicas = undefined;
    await purgeQueues('/', fixtureQueues);
  });

  const started = async (gate?: ReturnType<typeof stepGate>) => {
    const at = new Date(Date.now() + 11 * MINUTE);
    const schedulers = { a: ruleSchedulerHooks(at), b: ruleSchedulerHooks(at) };
    const two = await startTwoReplicas({
      profiles: [testProfile({ name: 'dev', replayRules: [rule] })],
      perReplica: (name: ReplicaName) => ({
        checkoutTestHooks: { ...schedulers[name].hooks, ...(name === 'a' && gate && { beforeApplyStep: () => gate.beforeApplyStep() }) },
      }),
    });
    replicas = two;
    const browser = two.browser();
    await browser.signIn({ sub: 'ana' });
    const listed = async (replica: ReplicaName) => {
      const { rules } = (await browser.to(two[replica]).get('/api/profiles/dev/replay-rules')).body;
      return rules[0];
    };
    return { two, schedulers, browser, listed };
  };

  it('skips a pass while an Operator holds the queue through the other Replica, naming them', async () => {
    const { two, schedulers, browser, listed } = await started();
    await due(['p-1']);
    const held = await browser.to(two.a).post(checkoutPath);
    expect(held.status).toBe(201);

    const pass = await schedulers.b.runPass('dev', RULE);

    expect(pass).toMatchObject({ status: 'skipped', summary: null });
    expect(pass!.reason).toContain('already checked out');
    expect((await listed('a')).state.paused).toBe(false);
    await browser.to(two.a).request('DELETE', `/api/checkouts/${held.body.checkout.id}`);
  });

  it('skips a pass of the same rule while it is in progress on the other Replica: the Operator claim refuses it before the lock', async () => {
    const gate = stepGate();
    const { schedulers } = await started(gate);
    await due(['p-1']);
    const first = schedulers.a.runPass('dev', RULE);
    await gate.atStep;

    const second = await schedulers.b.runPass('dev', RULE);

    expect(second).toMatchObject({ status: 'skipped', summary: null });
    expect(second!.reason).toContain('already has an active Checkout');
    gate.release();
    expect(ranSummary(await first)).toMatchObject({ replayed: 1 });
  });

  it('TODAY: a pause through either Replica answers at once and does not reach a pass in progress, which Replays every due Message', async () => {
    const gate = stepGate();
    const { two, schedulers, browser, listed } = await started(gate);
    await due(['p-1', 'p-2', 'p-3']);
    const running = schedulers.a.runPass('dev', RULE);
    await gate.atStep;

    const paused = await browser.to(two.b).post(`${rulePath}/pause`, { reason: 'incident' });

    expect(paused.status).toBe(200);
    gate.release();
    expect(ranSummary(await running)).toMatchObject({ held: 3, replayed: 3, failed: 0 });
    expect((await listed('a')).state.paused).toBe(true);
  });

  it('TODAY: a resume through one Replica leaves the other with no next pass, since nothing tells it', async () => {
    const { two, browser, listed } = await started();
    await browser.to(two.b).post(`${rulePath}/pause`, { reason: 'incident' });
    expect((await listed('b')).nextPassAt).toBeNull();
    // A never heard of the pause: its timer stands until it fires.
    expect((await listed('a')).nextPassAt).not.toBeNull();

    expect((await browser.to(two.b).post(`${rulePath}/resume`)).status).toBe(200);

    expect((await listed('b')).nextPassAt).not.toBeNull();
  });
});
