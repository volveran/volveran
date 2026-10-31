// Depth history in the audit store (migration v13): one Sample per dead-letter
// queue per sampling run, and one sampling run per Broker Profile. Written by
// the sampler, read by the history route, never read from the broker. Samples
// and runs older than VOLVERAN_HISTORY_RETENTION_DAYS are removed by the
// periodic retention job. The Applies and Rule Passes on a queue are read from
// the Audit Entries.
import type { DatabaseSync } from 'node:sqlite';
import type { HistoryStore, QueueSample, SampledQueue, SamplingRunRow, StoredSample, TakeOut } from './audit-store.js';
import { TAKEN_OUT, toRun, toSample, toTakeOuts, type RunRow, type SampleRow, type TakeOutRow } from './store-rows.js';

export class SqliteHistoryStore implements HistoryStore {
  constructor(private readonly db: DatabaseSync) {}

  /** Records a sampling run and its Samples in one commit. */
  async recordRun(profile: string, run: SamplingRunRow, samples: readonly QueueSample[]): Promise<void> {
    this.db.exec('BEGIN');
    try {
      this.db
        .prepare(
          `INSERT INTO sampling_runs (profile, at, ok, error_code, interval_ms) VALUES (?, ?, ?, ?, ?)
           ON CONFLICT (profile, at) DO UPDATE SET ok = excluded.ok, error_code = excluded.error_code, interval_ms = excluded.interval_ms`,
        )
        .run(profile, run.at, run.ok ? 1 : 0, run.errorCode, run.intervalMs);
      const insert = this.db.prepare(
        `INSERT INTO history_samples (profile, vhost, queue, at, depth, estimated_arrivals) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT (profile, vhost, queue, at) DO UPDATE SET depth = excluded.depth, estimated_arrivals = excluded.estimated_arrivals`,
      );
      for (const s of samples) insert.run(profile, s.vhost, s.queue, s.at, s.depth, s.estimatedArrivals);
      this.db.exec('COMMIT');
    } catch (err) {
      if (this.db.isTransaction) this.db.exec('ROLLBACK');
      throw err;
    }
  }

  /**
   * The queue's latest Sample before `before` (default: of all), or null. The
   * store has it, so a restart keeps the series going.
   */
  async latestSample({ profile, vhost, queue }: SampledQueue, before = Number.MAX_SAFE_INTEGER): Promise<StoredSample | null> {
    const row = this.db
      .prepare('SELECT at, depth, estimated_arrivals FROM history_samples WHERE profile = ? AND vhost = ? AND queue = ? AND at < ? ORDER BY at DESC LIMIT 1')
      .get(profile, vhost, queue, before) as SampleRow | undefined;
    return row ? toSample(row) : null;
  }

  /** The queue's Samples from `from` to `to` (inclusive), oldest first. */
  async samples({ profile, vhost, queue }: SampledQueue, from: number, to: number): Promise<StoredSample[]> {
    return this.db
      .prepare(
        'SELECT at, depth, estimated_arrivals FROM history_samples WHERE profile = ? AND vhost = ? AND queue = ? AND at >= ? AND at <= ? ORDER BY at',
      )
      .all(profile, vhost, queue, from, to)
      .map((row) => toSample(row as unknown as SampleRow));
  }

  /** The profile's runs in the range, oldest first, from its last good run before the range to its first good run after. */
  async runsAround(profile: string, from: number, to: number): Promise<SamplingRunRow[]> {
    const edge = (sql: string, at: number) =>
      (this.db.prepare(sql).get(profile, at) as { at: number | null }).at;
    const start = edge('SELECT MAX(at) AS at FROM sampling_runs WHERE profile = ? AND ok = 1 AND at <= ?', from);
    const end = edge('SELECT MIN(at) AS at FROM sampling_runs WHERE profile = ? AND ok = 1 AND at >= ?', to);
    return this.db
      .prepare('SELECT at, ok, error_code, interval_ms FROM sampling_runs WHERE profile = ? AND at >= ? AND at <= ? ORDER BY at')
      .all(profile, start ?? Number.MIN_SAFE_INTEGER, end ?? Number.MAX_SAFE_INTEGER)
      .map((row) => toRun(row as unknown as RunRow));
  }

  /** The profile's latest run and latest good run, for the latest snapshot after a restart. */
  async lastRuns(profile: string): Promise<{ last: SamplingRunRow | null; lastOk: SamplingRunRow | null }> {
    const read = (where: string) => {
      const row = this.db.prepare(`SELECT at, ok, error_code, interval_ms FROM sampling_runs WHERE profile = ? ${where} ORDER BY at DESC LIMIT 1`).get(profile);
      return row ? toRun(row as unknown as RunRow) : null;
    };
    return { last: read(''), lastOk: read('AND ok = 1') };
  }

  /** When the profile's latest good run before `before` ran, or null. */
  async lastGoodRunBefore(profile: string, before: number): Promise<number | null> {
    const row = this.db.prepare('SELECT MAX(at) AS at FROM sampling_runs WHERE profile = ? AND ok = 1 AND at < ?').get(profile, before) as { at: number | null };
    return row.at;
  }

  /** How many Messages Volverán took out of the queue after `after`, up to and including `until`. */
  async takenOut({ profile, vhost, queue }: SampledQueue, after: number, until: number): Promise<number> {
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS n FROM audit_entries
         WHERE profile = ? AND vhost = ? AND queue = ? AND created_at > ? AND created_at <= ? AND ${TAKEN_OUT}`,
      )
      .get(profile, vhost, queue, after, until) as { n: number };
    return Number(row.n);
  }

  /** The Applies and Rule Passes that took Messages out of the queue in the range, oldest first. */
  async takeOuts({ profile, vhost, queue }: SampledQueue, from: number, to: number): Promise<TakeOut[]> {
    const rows = this.db
      .prepare(
        `SELECT checkout_id, action, COUNT(*) AS n, MAX(created_at) AS at, MAX(operator_name) AS operator, MAX(rule) AS rule
         FROM audit_entries
         WHERE profile = ? AND vhost = ? AND queue = ? AND created_at >= ? AND created_at <= ? AND checkout_id IS NOT NULL AND ${TAKEN_OUT}
         GROUP BY checkout_id, action`,
      )
      .all(profile, vhost, queue, from, to) as unknown as TakeOutRow[];
    return toTakeOuts(rows);
  }

  /** Removes the Samples and sampling runs older than `before`. */
  async removeOlderThan(before: number): Promise<{ samples: number; runs: number }> {
    const samples = this.db.prepare('DELETE FROM history_samples WHERE at < ?').run(before);
    const runs = this.db.prepare('DELETE FROM sampling_runs WHERE at < ?').run(before);
    return { samples: Number(samples.changes), runs: Number(runs.changes) };
  }
}
