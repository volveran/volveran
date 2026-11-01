// The Background Leader with two Replicas (#92): retention runs once however many there
// are, the lease moves when the leader goes, and a stalled former leader's writes are
// refused. The store's own part is in the audit store contract, and the leader's timing
// on a test clock in test/unit/background-leader.test.ts.
import { rm } from 'node:fs/promises';
import { afterEach, describe, expect, it } from 'vitest';
import type { AuditStore } from '../../src/server/audit/audit-store.js';
import { PostgresAuditStore } from '../../src/server/audit/postgres-audit-store.js';
import { SqliteAuditStore } from '../../src/server/audit/sqlite-audit-store.js';
import { delayedAuditStore } from '../support/delayed-audit-store.js';
import { eventually, leaderHooks, makeTempDir, startApp, testProfile } from './harness.js';
import { startTwoReplicas, type ReplicaName, type TwoReplicas } from './two-replicas.js';

const DAY = 24 * 3_600_000;
const QUICK = { leaseMs: 800, renewMs: 100 };
/** Longer than any test here: only giving the lease up moves it. */
const LONG_LEASE = { leaseMs: 600_000, renewMs: 100 };

/** A Discard old enough for retention's age limit, with its body. */
const oldDiscard = (store: AuditStore, messageId: string) =>
  store.record({
    at: new Date(Date.now() - 40 * DAY),
    operator: { id: 'ana', displayName: 'ana' },
    brokerUser: 'u',
    profile: 'dev',
    vhost: '/',
    queue: 'orders.dlq',
    messageId,
    action: 'discard',
    reason: 'old',
    destination: null,
    checkoutId: 'c-1',
    message: { body: Buffer.from('body'), properties: {}, headers: {} },
  });

describe('the Background Leader', () => {
  let replicas: TwoReplicas | undefined;
  afterEach(async () => {
    await replicas?.close();
    replicas = undefined;
  });

  /** Two Replicas that count their retention runs. */
  const counted = async (timing: { leaseMs: number; renewMs: number }) => {
    const runs: Record<ReplicaName, number> = { a: 0, b: 0 };
    replicas = await startTwoReplicas({
      profiles: [testProfile({ name: 'dev' })],
      bodyRetention: { intervalMs: 50 },
      perReplica: (name) => ({
        leaderTestHooks: { timing },
        wrapAuditStore: (store) => delayedAuditStore(store, (call) => void (call === 'evictBodies' && runs[name]++)),
      }),
    });
    return { replicas, runs };
  };

  it('runs retention on one Replica only', async () => {
    const { runs } = await counted(QUICK);
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    expect(runs.a).toBeGreaterThan(1);
    expect(runs.b).toBe(0);
  });

  it('retention on the one leader removes what is past its limits', async () => {
    const { replicas } = await counted(QUICK);
    const store = await PostgresAuditStore.open(replicas.database.url);
    try {
      const id = await oldDiscard(store, 'past-limit');
      await eventually(async () => expect(await store.body(id)).toBeNull(), 5_000);
    } finally {
      await store.close();
    }
  });

  it('moves the lease to the other when the leader crashes, and retention carries on there', async () => {
    const { replicas, runs } = await counted(QUICK);
    await replicas.a.crash();
    await eventually(async () => expect(runs.b).toBeGreaterThan(0), 10_000);
  });

  it('moves the lease at once when the leader shuts down, well before it would run out', async () => {
    const { replicas, runs } = await counted(LONG_LEASE);
    expect(runs.b).toBe(0);
    await replicas.a.shutdown();
    await eventually(async () => expect(runs.b).toBeGreaterThan(0), 10_000);
  });

  it('keeps the lease with the new leader when the old one comes back', async () => {
    const { replicas, runs } = await counted(LONG_LEASE);
    await replicas.a.shutdown();
    await eventually(async () => expect(runs.b).toBeGreaterThan(0), 10_000);
    const before = runs.a;
    await replicas.a.restart();
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(runs.a).toBe(before);
  });

  it('refuses the writes of a stalled former leader that wakes up after another took over', async () => {
    const hooks = { a: leaderHooks(), b: leaderHooks() };
    const logs: Record<ReplicaName, Array<Record<string, any>>> = { a: [], b: [] };
    let stall: Promise<void> | null = null;
    let wake = () => {};
    replicas = await startTwoReplicas({
      profiles: [testProfile({ name: 'dev' })],
      perReplica: (name) => ({
        leaderTestHooks: hooks[name].hooks,
        logs: logs[name],
        wrapAuditStore: name === 'a' ? (store) => delayedAuditStore(store, (call) => (call === 'evictBodies' && stall) || undefined) : undefined,
      }),
    });
    expect([hooks.a.isLeader(), hooks.b.isLeader()]).toEqual([true, false]);

    // a's retention stops just before its write, and a's clock stops with it.
    stall = new Promise<void>((resolve) => (wake = resolve));
    hooks.a.advance(60 * 60_000);
    // b's clock runs on, past a's lease, and b takes over; its own retention has run by then.
    hooks.b.advance(60 * 60_000 + 60_000);
    await hooks.b.claimNow();
    await eventually(async () => expect(hooks.b.isLeader()).toBe(true), 5_000);

    const store = await PostgresAuditStore.open(replicas.database.url);
    try {
      const id = await oldDiscard(store, 'after-takeover');
      wake();
      await eventually(async () => expect(logs.a.some((l) => /no longer the Background Leader/.test(l.msg))).toBe(true), 5_000);
      expect(await store.body(id)).not.toBeNull();
      expect(logs.a.filter((l) => l.level >= 50)).toEqual([]);
    } finally {
      await store.close();
    }

    // Once a looks, it knows.
    await hooks.a.claimNow();
    expect(hooks.a.isLeader()).toBe(false);
  });
});

describe('a single Replica on SQLite', () => {
  it('is simply its own leader: retention has run before the app listens, again after a restart', async () => {
    const dir = await makeTempDir('leader-sqlite');
    try {
      const env = { VOLVERAN_POSTGRES_URL: undefined };
      for (const messageId of ['first', 'second']) {
        const seed = new SqliteAuditStore(dir);
        const id = await oldDiscard(seed, messageId);
        await seed.close();
        const hooks = leaderHooks();
        const app = await startApp({ profiles: [testProfile({ name: 'dev' })], dataDir: dir, env, leaderTestHooks: hooks.hooks });
        try {
          expect(hooks.isLeader()).toBe(true);
          expect((await app.get(`/api/audit-entries/${id}`)).body.entry.bodyExpiredAt).toEqual(expect.any(String));
        } finally {
          await app.close();
        }
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
