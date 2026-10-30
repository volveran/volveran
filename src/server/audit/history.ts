// Depth history in the audit store (migration v13): one Sample per dead-letter
// queue per sampling run, and one sampling run per Broker Profile. Written by
// the sampler, read by the history route, never read from the broker. Samples
// and runs older than VOLVERAN_HISTORY_RETENTION_DAYS are removed by the
// periodic retention job. The Applies and Rule Passes on a queue are read from
// the Audit Entries.
import type { DatabaseSync } from 'node:sqlite';

export interface StoredSample {
  /** Epoch milliseconds. */
  at: number;
  depth: number;
  estimatedArrivals: number | null;
}

export interface SamplingRunRow {
  /** Epoch milliseconds. */
  at: number;
  ok: boolean;
  /** Why it failed; null on a good run. */
  errorCode: string | null;
}

export interface QueueSample extends StoredSample {
  vhost: string;
  queue: string;
}

export interface SampledQueue {
  profile: string;
  vhost: string;
  queue: string;
}

/** One Apply or Rule Pass's Messages taken out of a queue, by Decision. */
export interface TakeOut {
  checkoutId: string;
  at: number;
  operator: string;
  rule: string | null;
  counts: { discard: number; replay: number; move: number };
}

/** Taking a Message out is one of these, carried out. A Keep or a failed step leaves it in the queue. */
const TAKEN_OUT = `action IN ('discard', 'replay', 'move') AND outcome = 'done'`;

export class HistoryStore {
  constructor(private readonly db: DatabaseSync) {}

  /** Records a sampling run and its Samples in one commit. */
  recordRun(profile: string, run: SamplingRunRow, samples: readonly QueueSample[]): void {
    this.db.exec('BEGIN');
    try {
      this.db
        .prepare('INSERT OR REPLACE INTO sampling_runs (profile, at, ok, error_code) VALUES (?, ?, ?, ?)')
        .run(profile, run.at, run.ok ? 1 : 0, run.errorCode);
      const insert = this.db.prepare(
        'INSERT OR REPLACE INTO history_samples (profile, vhost, queue, at, depth, estimated_arrivals) VALUES (?, ?, ?, ?, ?, ?)',
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
  latestSample({ profile, vhost, queue }: SampledQueue, before = Number.MAX_SAFE_INTEGER): StoredSample | null {
    const row = this.db
      .prepare('SELECT at, depth, estimated_arrivals FROM history_samples WHERE profile = ? AND vhost = ? AND queue = ? AND at < ? ORDER BY at DESC LIMIT 1')
      .get(profile, vhost, queue, before) as SampleRow | undefined;
    return row ? toSample(row) : null;
  }

  /** The queue's Samples from `from` to `to` (inclusive), oldest first. */
  samples({ profile, vhost, queue }: SampledQueue, from: number, to: number): StoredSample[] {
    return this.db
      .prepare(
        'SELECT at, depth, estimated_arrivals FROM history_samples WHERE profile = ? AND vhost = ? AND queue = ? AND at >= ? AND at <= ? ORDER BY at',
      )
      .all(profile, vhost, queue, from, to)
      .map((row) => toSample(row as unknown as SampleRow));
  }

  /** The profile's runs in the range, oldest first, from its last good run before the range to its first good run after. */
  runsAround(profile: string, from: number, to: number): SamplingRunRow[] {
    const edge = (sql: string, at: number) =>
      (this.db.prepare(sql).get(profile, at) as { at: number | null }).at;
    const start = edge('SELECT MAX(at) AS at FROM sampling_runs WHERE profile = ? AND ok = 1 AND at <= ?', from);
    const end = edge('SELECT MIN(at) AS at FROM sampling_runs WHERE profile = ? AND ok = 1 AND at >= ?', to);
    return this.db
      .prepare('SELECT at, ok, error_code FROM sampling_runs WHERE profile = ? AND at >= ? AND at <= ? ORDER BY at')
      .all(profile, start ?? Number.MIN_SAFE_INTEGER, end ?? Number.MAX_SAFE_INTEGER)
      .map((row) => toRun(row as unknown as RunRow));
  }

  /** The profile's latest run and latest good run, for the latest snapshot after a restart. */
  lastRuns(profile: string): { last: SamplingRunRow | null; lastOk: SamplingRunRow | null } {
    const read = (where: string) => {
      const row = this.db.prepare(`SELECT at, ok, error_code FROM sampling_runs WHERE profile = ? ${where} ORDER BY at DESC LIMIT 1`).get(profile);
      return row ? toRun(row as unknown as RunRow) : null;
    };
    return { last: read(''), lastOk: read('AND ok = 1') };
  }

  /** How many Messages Volverán took out of the queue after `after`, up to and including `until`. */
  takenOut({ profile, vhost, queue }: SampledQueue, after: number, until: number): number {
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS n FROM audit_entries
         WHERE profile = ? AND vhost = ? AND queue = ? AND created_at > ? AND created_at <= ? AND ${TAKEN_OUT}`,
      )
      .get(profile, vhost, queue, after, until) as { n: number };
    return Number(row.n);
  }

  /** The Applies and Rule Passes that took Messages out of the queue in the range, oldest first. */
  takeOuts({ profile, vhost, queue }: SampledQueue, from: number, to: number): TakeOut[] {
    const rows = this.db
      .prepare(
        `SELECT checkout_id, action, COUNT(*) AS n, MAX(created_at) AS at, MAX(operator_name) AS operator, MAX(rule) AS rule
         FROM audit_entries
         WHERE profile = ? AND vhost = ? AND queue = ? AND created_at >= ? AND created_at <= ? AND checkout_id IS NOT NULL AND ${TAKEN_OUT}
         GROUP BY checkout_id, action`,
      )
      .all(profile, vhost, queue, from, to) as unknown as Array<{
      checkout_id: string;
      action: 'discard' | 'replay' | 'move';
      n: number;
      at: number;
      operator: string;
      rule: string | null;
    }>;
    const byCheckout = new Map<string, TakeOut>();
    for (const row of rows) {
      const mark = byCheckout.get(row.checkout_id) ?? {
        checkoutId: row.checkout_id,
        at: row.at,
        operator: row.operator,
        rule: row.rule,
        counts: { discard: 0, replay: 0, move: 0 },
      };
      mark.at = Math.max(mark.at, row.at);
      mark.counts[row.action] = Number(row.n);
      byCheckout.set(row.checkout_id, mark);
    }
    return [...byCheckout.values()].sort((a, b) => a.at - b.at);
  }

  /** Removes the Samples and sampling runs older than `before`. */
  removeOlderThan(before: number): { samples: number; runs: number } {
    const samples = this.db.prepare('DELETE FROM history_samples WHERE at < ?').run(before);
    const runs = this.db.prepare('DELETE FROM sampling_runs WHERE at < ?').run(before);
    return { samples: Number(samples.changes), runs: Number(runs.changes) };
  }
}

interface SampleRow {
  at: number;
  depth: number;
  estimated_arrivals: number | null;
}

interface RunRow {
  at: number;
  ok: number;
  error_code: string | null;
}

function toSample(row: SampleRow): StoredSample {
  return { at: row.at, depth: row.depth, estimatedArrivals: row.estimated_arrivals };
}

function toRun(row: RunRow): SamplingRunRow {
  return { at: row.at, ok: row.ok === 1, errorCode: row.error_code };
}
