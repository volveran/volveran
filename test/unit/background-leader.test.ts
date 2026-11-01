// The Background Leader on a test clock: who holds the lease, when it moves, and that
// jobs start and stop with it. The lease is the real one on SQLite's store.
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AuditStore, LeaderLeaseStore, LeaseFence } from '../../src/server/audit/audit-store.js';
import { SqliteAuditStore } from '../../src/server/audit/sqlite-audit-store.js';
import { BackgroundLeader, LEADER_TAKEOVER_MS, type LeaderJob } from '../../src/server/leader/background-leader.js';
import type { RuleClock } from '../../src/server/replay-rules/rule-clock.js';

/** A clock moving only when told; `advance` fires what is due and lets the promises it started settle. */
function testClock(start = 1_000_000) {
  let now = start;
  let timers: Array<{ at: number; run: () => void }> = [];
  const clock: RuleClock = {
    now: () => new Date(now),
    setTimer(run, ms) {
      const timer = { at: now + ms, run };
      timers.push(timer);
      return { cancel: () => void (timers = timers.filter((t) => t !== timer)) };
    },
  };
  const settle = () => new Promise((resolve) => setTimeout(resolve, 5));
  return {
    clock,
    /** Moves in steps, so a timer set by a timer fires on time. */
    async advance(ms: number, step = 500) {
      for (let moved = 0; moved < ms; moved += step) {
        now += step;
        const due = timers.filter((t) => t.at <= now);
        timers = timers.filter((t) => t.at > now);
        for (const t of due) t.run();
        await settle();
      }
    },
  };
}

function recordingJob() {
  const events: string[] = [];
  const fences: LeaseFence[] = [];
  const job: LeaderJob = {
    name: 'test job',
    start: async (fence) => {
      events.push('start');
      fences.push(fence);
    },
    stop: async () => {
      events.push('stop');
    },
  };
  return { job, events, fences };
}

describe('the Background Leader', () => {
  const stores: AuditStore[] = [];
  const leaders: BackgroundLeader[] = [];
  let time = testClock();
  beforeEach(() => {
    time = testClock();
  });

  const store = () => {
    const opened = new SqliteAuditStore();
    stores.push(opened);
    return opened.leaderLease;
  };
  const leaderOn = (lease: LeaderLeaseStore, jobs: LeaderJob[] = [], clock = time.clock, onError: (err: unknown) => void = (err) => { throw err; }) => {
    const leader = new BackgroundLeader({ lease, clock, jobs, onError });
    leaders.push(leader);
    return leader;
  };

  afterEach(async () => {
    await Promise.all(leaders.splice(0).map((leader) => leader.stop()));
    await Promise.all(stores.splice(0).map((opened) => opened.close()));
  });

  it('is the leader at once on a store of its own, with its jobs started before start() answers', async () => {
    const { job, events } = recordingJob();
    const leader = leaderOn(store(), [job]);
    await leader.start();
    expect(leader.isLeader).toBe(true);
    expect(events).toEqual(['start']);
  });

  it('on SQLite, is the leader at once after a crash, on the same data', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'leader-'));
    try {
      const before = new SqliteAuditStore(dir);
      stores.push(before);
      // Never stopped, so its lease has not been given up.
      await new BackgroundLeader({ lease: before.leaderLease, jobs: [], clock: testClock().clock, onError: () => {} }).start();
      await before.close();

      const after = new SqliteAuditStore(dir);
      stores.push(after);
      const restarted = leaderOn(after.leaderLease);
      await restarted.start();
      expect(restarted.isLeader).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('runs jobs on one leader only', async () => {
    const lease = store();
    const first = recordingJob();
    const second = recordingJob();
    const a = leaderOn(lease, [first.job]);
    const b = leaderOn(lease, [second.job]);
    await a.start();
    await b.start();
    await time.advance(60_000);
    expect([a.isLeader, b.isLeader]).toEqual([true, false]);
    expect(first.events).toEqual(['start']);
    expect(second.events).toEqual([]);
  });

  it('gives its jobs a fence the store takes', async () => {
    const { job, fences } = recordingJob();
    const opened = new SqliteAuditStore();
    stores.push(opened);
    await leaderOn(opened.leaderLease, [job]).start();
    await expect(opened.notifications.removeOlderThan(new Date(), fences[0])).resolves.toBe(0);
  });

  it('starts jobs in order and stops them in reverse, then gives the lease up so another takes it within one renewal', async () => {
    const lease = store();
    const order: string[] = [];
    const named = (name: string): LeaderJob => ({
      name,
      start: async () => void order.push(`start ${name}`),
      stop: async () => void order.push(`stop ${name}`),
    });
    const a = leaderOn(lease, [named('x'), named('y')]);
    const b = leaderOn(lease);
    await a.start();
    await b.start();
    await a.stop();
    expect(order).toEqual(['start x', 'start y', 'stop y', 'stop x']);
    expect(a.isLeader).toBe(false);
    await time.advance(5_000);
    expect(b.isLeader).toBe(true);
  });

  it('moves to another within the stated time when the leader goes without a word', async () => {
    const lease = store();
    const silent = testClock();
    const a = leaderOn(lease, [], silent.clock);
    const { job, events } = recordingJob();
    const b = leaderOn(lease, [job]);
    await a.start();
    await b.start();
    // Only b's clock runs from here: a neither renews nor knows.
    await time.advance(10_000);
    expect(b.isLeader).toBe(false);
    expect(LEADER_TAKEOVER_MS).toBe(20_000);
    await time.advance(10_000);
    expect(b.isLeader).toBe(true);
    expect(events).toEqual(['start']);
  });

  it('does not take the lease while the leader keeps renewing', async () => {
    const lease = store();
    const a = leaderOn(lease);
    const b = leaderOn(lease);
    await a.start();
    await b.start();
    await time.advance(5 * LEADER_TAKEOVER_MS);
    expect([a.isLeader, b.isLeader]).toEqual([true, false]);
  });

  it('stops its jobs when it finds another holds the lease, and takes it back when that one goes', async () => {
    const lease = store();
    const stalled = testClock();
    const first = recordingJob();
    const a = leaderOn(lease, [first.job], stalled.clock);
    const b = leaderOn(lease);
    await a.start();
    await b.start();
    await time.advance(LEADER_TAKEOVER_MS);
    expect(b.isLeader).toBe(true);

    // a wakes up, at a time its own clock agrees has passed, and looks.
    await stalled.advance(5_000);
    expect(a.isLeader).toBe(false);
    expect(first.events).toEqual(['start', 'stop']);

    await b.stop();
    await stalled.advance(5_000);
    expect(a.isLeader).toBe(true);
    expect(first.events).toEqual(['start', 'stop', 'start']);
  });

  it('starts its jobs again, with the new fence, when the lease came back to it between two claims', async () => {
    const lease = store();
    const { job, events, fences } = recordingJob();
    const stalled = testClock();
    const a = leaderOn(lease, [job], stalled.clock);
    await a.start();
    await lease.claim('other', 1_000_000 + LEADER_TAKEOVER_MS, 1_000);
    await lease.release('other');

    await stalled.advance(5_000);
    expect(a.isLeader).toBe(true);
    expect(events).toEqual(['start', 'stop', 'start']);
    expect(fences[1]!.term).toBeGreaterThan(fences[0]!.term);
  });

  it('stops its jobs when it cannot renew before the lease runs out, and carries on when the store answers again', async () => {
    const opened = store();
    let down = false;
    const lease: LeaderLeaseStore = {
      claim: (...args) => (down ? Promise.reject(new Error('store down')) : opened.claim(...args)),
      release: (holder) => opened.release(holder),
    };
    const { job, events } = recordingJob();
    const errors: unknown[] = [];
    const leader = leaderOn(lease, [job], time.clock, (err) => errors.push(err));
    await leader.start();

    down = true;
    await time.advance(10_000);
    expect(leader.isLeader).toBe(true);
    await time.advance(5_000);
    expect(leader.isLeader).toBe(false);
    expect(events).toEqual(['start', 'stop']);
    expect(errors.length).toBeGreaterThan(0);

    down = false;
    await time.advance(5_000);
    expect(leader.isLeader).toBe(true);
    expect(events).toEqual(['start', 'stop', 'start']);
  });

  it('keeps renewing while a job takes long to start', async () => {
    const lease = store();
    let started!: () => void;
    const slow: LeaderJob = { name: 'slow', start: () => new Promise<void>((resolve) => (started = resolve)), stop: async () => {} };
    const a = leaderOn(lease, [slow]);
    const b = leaderOn(lease);
    const starting = a.start();
    await time.advance(100, 100);
    await b.start();
    await time.advance(2 * LEADER_TAKEOVER_MS);
    expect(b.isLeader).toBe(false);
    started();
    await starting;
  });

  it('reports a job that fails to start or stop, and still runs the others', async () => {
    const errors: unknown[] = [];
    const { job, events } = recordingJob();
    const broken: LeaderJob = {
      name: 'broken',
      start: () => Promise.reject(new Error('no start')),
      stop: () => Promise.reject(new Error('no stop')),
    };
    const leader = leaderOn(store(), [broken, job], time.clock, (err) => errors.push(err));
    await leader.start();
    expect(events).toEqual(['start']);
    await leader.stop();
    expect(events).toEqual(['start', 'stop']);
    expect(errors.map((e) => (e as Error).message)).toEqual(['no start', 'no stop']);
  });

  it('stops whatever happens to the store, and does not claim after', async () => {
    let claims = 0;
    const lease: LeaderLeaseStore = {
      claim: async (holder, now, ms) => ({ holder, term: ++claims, expiresAt: now + ms }),
      release: () => Promise.reject(new Error('store down')),
    };
    const leader = leaderOn(lease, [], time.clock, () => {});
    await leader.start();
    await expect(leader.stop()).resolves.toBeUndefined();
    const before = claims;
    await time.advance(20_000);
    expect(claims).toBe(before);
  });
});
