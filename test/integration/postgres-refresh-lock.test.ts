// The token refresh lock on PostgreSQL when its holder goes silent, as a Replica that froze
// or lost its network does without closing its connection (ADR 0013, ADR 0014). Another
// Replica's refresh gives up within the lock wait, the database is left with no backend
// still waiting for the lock, and the silent holder's lock does not outlive it for long.
import type pg from 'pg';
import { afterEach, describe, expect, it } from 'vitest';
import { REFRESH_LOCK_WAIT_MS, RefreshBusy, type StoredSession } from '../../src/server/audit/audit-store.js';
import { createPool } from '../../src/server/audit/postgres-connection.js';
import { migrate } from '../../src/server/audit/postgres-migrations.js';
import { PostgresSessionStore } from '../../src/server/audit/postgres-sessions.js';
import { startTcpProxy, type TcpProxy } from '../support/tcp-proxy.js';
import { createTestDatabase, type TestDatabase } from '../support/test-postgres.js';

const NOW = Date.now();
const session: StoredSession = {
  operator: { id: 'sub-123', displayName: 'ana@example.com', email: 'ana@example.com', groups: ['ops'] },
  tokens: 'sealed-tokens',
  expiresAt: NOW + 3_600_000,
  idleExpiresAt: NOW + 3_600_000,
};

/** The advisory locks of the database, held or waited for, with what their backends are doing. */
async function advisoryLocks(database: TestDatabase) {
  const { rows } = await database.query(
    `SELECT a.pid, a.state, a.wait_event_type, l.granted
     FROM pg_locks l JOIN pg_stat_activity a ON a.pid = l.pid
     WHERE l.locktype = 'advisory' AND a.datname = current_database()`,
  );
  return rows as Array<{ pid: number; state: string; wait_event_type: string | null; granted: boolean }>;
}

describe('the token refresh lock on PostgreSQL with a silent holder', () => {
  let database: TestDatabase | undefined;
  let proxy: TcpProxy | undefined;
  const pools: pg.Pool[] = [];
  /** Ends the silent holder's refresh, so its pool can close. */
  let letGo: (() => void) | undefined;

  afterEach(async () => {
    letGo?.();
    await proxy?.close();
    await Promise.all(pools.splice(0).map((pool) => pool.end().catch(() => {})));
    await database?.drop();
    proxy = database = letGo = undefined;
  });

  /** Two Replicas' session stores on one database; the first reaches it through a proxy that can go silent. */
  async function twoStores() {
    database = await createTestDatabase();
    const url = new URL(database.url);
    proxy = await startTcpProxy(Number(url.port));
    const proxied = new URL(database.url);
    proxied.port = String(proxy.port);
    const [silenceable, direct] = [createPool(proxied.href), createPool(database.url)];
    pools.push(silenceable, direct);
    await migrate(direct);
    const holder = new PostgresSessionStore(silenceable);
    const other = new PostgresSessionStore(direct);
    await other.addSession('s-1', session, NOW);
    // The holder takes the lock, then waits for ever, as on a provider it never hears from.
    let reached!: () => void;
    const holding = new Promise<void>((resolve) => (reached = resolve));
    void holder
      .refreshTokens('s-1', NOW, async () => {
        reached();
        return new Promise<string>((_, reject) => (letGo = () => reject(new Error('the test is over'))));
      })
      .catch(() => {});
    await holding;
    proxy.silence();
    return { other };
  }

  it('leaves no backend waiting for the lock once a refresh gives up on it, within the lock wait', async () => {
    const { other } = await twoStores();
    const startedAt = Date.now();
    let called = false;
    const refused = await other
      .refreshTokens('s-1', NOW, async () => {
        called = true;
        return 'rotated';
      })
      .then(
        () => null,
        (err: unknown) => err,
      );
    const waited = Date.now() - startedAt;

    // Only the silent holder is left, holding the lock.
    const locks = await advisoryLocks(database!);
    expect(locks.filter((l) => !l.granted)).toEqual([]);
    expect(locks).toHaveLength(1);

    expect(refused).toBeInstanceOf(RefreshBusy);
    expect(called).toBe(false);
    expect(waited).toBeGreaterThanOrEqual(REFRESH_LOCK_WAIT_MS - 100);
    expect(waited).toBeLessThan(REFRESH_LOCK_WAIT_MS + 2_000);
  }, 60_000);

  it("frees a silent holder's lock, so a later refresh goes through and saves", async () => {
    const { other } = await twoStores();
    await expect.poll(async () => advisoryLocks(database!), { timeout: 40_000, interval: 500 }).toEqual([]);
    expect(await other.refreshTokens('s-1', NOW, async () => 'rotated')).toBe(true);
    expect((await other.session('s-1', NOW))?.tokens).toBe('rotated');
  }, 60_000);
});
