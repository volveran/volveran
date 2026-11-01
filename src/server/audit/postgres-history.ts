// Depth history on PostgreSQL. See sqlite-history.ts for what is kept and why.
import type pg from 'pg';
import type { HistoryStore, LeaseFence, QueueSample, SampledQueue, StoredSamplingRun, StoredSample, TakeOut } from './audit-store.js';
import { fenced } from './postgres-leader-lease.js';
import { TAKEN_OUT, toRun, toSample, toTakeOuts, type RunRow, type SampleRow, type TakeOutRow } from './store-rows.js';

export class PostgresHistoryStore implements HistoryStore {
  constructor(private readonly pool: pg.Pool) {}

  async recordRun(profile: string, run: StoredSamplingRun, samples: readonly QueueSample[], fence?: LeaseFence): Promise<void> {
    await fenced(this.pool, fence, async (client) => {
      await client.query(
        `INSERT INTO sampling_runs (profile, at, ok, error_code, interval_ms) VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (profile, at) DO UPDATE SET ok = excluded.ok, error_code = excluded.error_code, interval_ms = excluded.interval_ms`,
        [profile, run.at, run.ok ? 1 : 0, run.errorCode, run.intervalMs],
      );
      for (const s of samples) {
        await client.query(
          `INSERT INTO history_samples (profile, vhost, queue, at, depth, estimated_arrivals) VALUES ($1, $2, $3, $4, $5, $6)
           ON CONFLICT (profile, vhost, queue, at) DO UPDATE SET depth = excluded.depth, estimated_arrivals = excluded.estimated_arrivals`,
          [profile, s.vhost, s.queue, s.at, s.depth, s.estimatedArrivals],
        );
      }
    });
  }

  async latestSample({ profile, vhost, queue }: SampledQueue, before = Number.MAX_SAFE_INTEGER): Promise<StoredSample | null> {
    const { rows } = await this.pool.query<SampleRow>(
      'SELECT at, depth, estimated_arrivals FROM history_samples WHERE profile = $1 AND vhost = $2 AND queue = $3 AND at < $4 ORDER BY at DESC LIMIT 1',
      [profile, vhost, queue, before],
    );
    return rows[0] ? toSample(rows[0]) : null;
  }

  async samples({ profile, vhost, queue }: SampledQueue, from: number, to: number): Promise<StoredSample[]> {
    const { rows } = await this.pool.query<SampleRow>(
      'SELECT at, depth, estimated_arrivals FROM history_samples WHERE profile = $1 AND vhost = $2 AND queue = $3 AND at >= $4 AND at <= $5 ORDER BY at',
      [profile, vhost, queue, from, to],
    );
    return rows.map(toSample);
  }

  async runsAround(profile: string, from: number, to: number): Promise<StoredSamplingRun[]> {
    const { rows } = await this.pool.query<RunRow>(
      `SELECT at, ok, error_code, interval_ms FROM sampling_runs
       WHERE profile = $1
         AND at >= COALESCE((SELECT MAX(at) FROM sampling_runs WHERE profile = $1 AND ok = 1 AND at <= $2), $4)
         AND at <= COALESCE((SELECT MIN(at) FROM sampling_runs WHERE profile = $1 AND ok = 1 AND at >= $3), $5)
       ORDER BY at`,
      [profile, from, to, Number.MIN_SAFE_INTEGER, Number.MAX_SAFE_INTEGER],
    );
    return rows.map(toRun);
  }

  async lastRuns(profile: string): Promise<{ last: StoredSamplingRun | null; lastOk: StoredSamplingRun | null }> {
    const { rows } = await this.pool.query<RunRow & { good: boolean }>(
      `(SELECT at, ok, error_code, interval_ms, false AS good FROM sampling_runs WHERE profile = $1 ORDER BY at DESC LIMIT 1)
       UNION ALL
       (SELECT at, ok, error_code, interval_ms, true AS good FROM sampling_runs WHERE profile = $1 AND ok = 1 ORDER BY at DESC LIMIT 1)`,
      [profile],
    );
    const of = (good: boolean) => {
      const row = rows.find((r) => r.good === good);
      return row ? toRun(row) : null;
    };
    return { last: of(false), lastOk: of(true) };
  }

  async lastGoodRunBefore(profile: string, before: number): Promise<number | null> {
    const { rows } = await this.pool.query<{ at: number | null }>('SELECT MAX(at) AS at FROM sampling_runs WHERE profile = $1 AND ok = 1 AND at < $2', [profile, before]);
    return rows[0]!.at;
  }

  async takenOut({ profile, vhost, queue }: SampledQueue, after: number, until: number): Promise<number> {
    const { rows } = await this.pool.query<{ n: number }>(
      `SELECT COUNT(*) AS n FROM audit_entries
       WHERE profile = $1 AND vhost = $2 AND queue = $3 AND created_at > $4 AND created_at <= $5 AND ${TAKEN_OUT}`,
      [profile, vhost, queue, after, until],
    );
    return rows[0]!.n;
  }

  async takeOuts({ profile, vhost, queue }: SampledQueue, from: number, to: number): Promise<TakeOut[]> {
    const { rows } = await this.pool.query<TakeOutRow>(
      `SELECT checkout_id, action, COUNT(*) AS n, MAX(created_at) AS at, MAX(operator_name) AS operator, MAX(rule) AS rule
       FROM audit_entries
       WHERE profile = $1 AND vhost = $2 AND queue = $3 AND created_at >= $4 AND created_at <= $5 AND checkout_id IS NOT NULL AND ${TAKEN_OUT}
       GROUP BY checkout_id, action`,
      [profile, vhost, queue, from, to],
    );
    return toTakeOuts(rows);
  }

  async removeOlderThan(before: number, fence?: LeaseFence): Promise<{ samples: number; runs: number }> {
    return fenced(this.pool, fence, async (client) => {
      const samples = await client.query('DELETE FROM history_samples WHERE at < $1', [before]);
      const runs = await client.query('DELETE FROM sampling_runs WHERE at < $1', [before]);
      return { samples: samples.rowCount ?? 0, runs: runs.rowCount ?? 0 };
    });
  }
}
