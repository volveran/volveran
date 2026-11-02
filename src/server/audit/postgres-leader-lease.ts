// The leader lease on PostgreSQL: one row every Replica shares (ADR 0014).
import type pg from 'pg';
import { LeaderLeaseLost, type LeaderLeaseGrant, type LeaderLeaseStore, type LeaseFence } from './audit-store.js';
import { transaction } from './postgres-connection.js';

export class PostgresLeaderLease implements LeaderLeaseStore {
  constructor(private readonly pool: pg.Pool) {}

  async claim(holder: string, now: number, durationMs: number): Promise<LeaderLeaseGrant | null> {
    const expiresAt = now + durationMs;
    const { rows } = await this.pool.query<{ term: string | number }>(
      `INSERT INTO leader_lease (id, holder, term, expires_at) VALUES (1, $1, 1, $2)
       ON CONFLICT (id) DO UPDATE SET
         holder = EXCLUDED.holder,
         expires_at = EXCLUDED.expires_at,
         term = CASE WHEN leader_lease.holder = EXCLUDED.holder THEN leader_lease.term ELSE leader_lease.term + 1 END
       WHERE leader_lease.holder = EXCLUDED.holder OR leader_lease.holder IS NULL OR leader_lease.expires_at <= $3
       RETURNING term`,
      [holder, expiresAt, now],
    );
    const row = rows[0];
    return row ? { holder, term: Number(row.term), expiresAt } : null;
  }

  async release(holder: string): Promise<void> {
    await this.pool.query('UPDATE leader_lease SET holder = NULL WHERE holder = $1', [holder]);
  }

  async currentHolder(): Promise<string | null> {
    const { rows } = await this.pool.query<{ holder: string | null }>('SELECT holder FROM leader_lease WHERE id = 1');
    return rows[0]?.holder ?? null;
  }
}

/**
 * Runs `work` in one transaction that first checks the fence, if any. The check keeps
 * the row locked to the commit, so a claim taking the lease waits for the write, and
 * a write that starts after it is refused: there is no moment when both hold.
 */
export function fenced<T>(pool: pg.Pool, fence: LeaseFence | undefined, work: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  return transaction(pool, async (client) => {
    if (fence) {
      const { rows } = await client.query('SELECT 1 FROM leader_lease WHERE holder = $1 AND term = $2 FOR SHARE', [fence.holder, fence.term]);
      if (rows.length === 0) throw new LeaderLeaseLost();
    }
    return work(client);
  });
}
