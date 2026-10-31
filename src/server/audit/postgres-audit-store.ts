// The audit store interface on PostgreSQL (ADR 0013). The pool is bounded, and a call
// of several statements runs on one connection, in one transaction (`transaction`).
// A commit is durable when its promise resolves, as ADR 0001 needs of `record`.
import type pg from 'pg';
import { insertEntry, searchEntries, toEntry, type EntryRow } from './audit-entry-sql.js';
import type {
  AlertStore,
  AuditEntry,
  AuditQuery,
  AuditStore,
  BodyEviction,
  HistoryStore,
  NewAuditEntry,
  NotificationStore,
  RuleStateStore,
} from './audit-store.js';
import { createPool, storableValues, transaction } from './postgres-connection.js';
import { migrate } from './postgres-migrations.js';
import { unfinishedAlerts, unfinishedHistory, unfinishedNotifications, unfinishedRuleState } from './postgres-unfinished.js';
import type { AuditCanaryOutcome, AuditOutcome } from '../../shared/audit.js';

const numbered = (position: number) => `$${position}`;

export class PostgresAuditStore implements AuditStore {
  readonly ruleState: RuleStateStore = unfinishedRuleState;
  readonly history: HistoryStore = unfinishedHistory;
  readonly notifications: NotificationStore = unfinishedNotifications;
  readonly alerts: AlertStore = unfinishedAlerts;
  private closing: Promise<void> | undefined;

  private constructor(private readonly pool: pg.Pool) {}

  /** Connects to the database at `url` and brings its schema up to date. Refuses a store newer than this version. */
  static async open(url: string): Promise<PostgresAuditStore> {
    const pool = createPool(url);
    try {
      await migrate(pool);
    } catch (err) {
      await pool.end();
      throw err;
    }
    return new PostgresAuditStore(pool);
  }

  async record(entry: NewAuditEntry): Promise<number> {
    const { sql, values } = insertEntry(entry, numbered);
    return transaction(this.pool, async (client) => {
      const { rows } = await client.query<{ id: number }>(`${sql} RETURNING id`, storableValues(values));
      const { id } = rows[0]!;
      const body = entry.message?.body;
      if (body) await client.query('INSERT INTO audit_message_bodies (entry_id, body) VALUES ($1, $2)', [id, body]);
      return id;
    });
  }

  async setOutcome(id: number, outcome: Exclude<AuditOutcome, 'pending'>, reason: string | null = null): Promise<void> {
    await this.pool.query('UPDATE audit_entries SET outcome = $1, outcome_reason = $2 WHERE id = $3', storableValues([outcome, reason, id]));
  }

  async setCanaryOutcome(id: number, outcome: AuditCanaryOutcome): Promise<void> {
    await this.pool.query('UPDATE audit_entries SET canary_outcome = $1 WHERE id = $2', [outcome, id]);
  }

  async list(query: AuditQuery = {}): Promise<AuditEntry[]> {
    const { sql, values } = searchEntries(query, numbered);
    const { rows } = await this.pool.query<EntryRow>(sql, storableValues(values));
    return rows.map(toEntry);
  }

  async get(id: number): Promise<AuditEntry | null> {
    const { rows } = await this.pool.query<EntryRow>('SELECT * FROM audit_entries WHERE id = $1', [id]);
    return rows[0] ? toEntry(rows[0]) : null;
  }

  async body(id: number): Promise<Buffer | null> {
    const { rows } = await this.pool.query<{ body: Buffer }>('SELECT body FROM audit_message_bodies WHERE entry_id = $1', [id]);
    return rows[0]?.body ?? null;
  }

  /**
   * One statement, so one transaction. `newer_bytes`: this body plus every newer one. A
   * call that waited for another to finish finds the row marked, and neither counts nor
   * marks it again.
   */
  async evictBodies({ now, maxAgeMs, maxBodyBytes }: BodyEviction): Promise<{ evicted: number }> {
    const { rows } = await this.pool.query<{ evicted: number }>(
      `WITH stored AS (
         SELECT id, created_at,
                SUM(body_bytes) OVER (ORDER BY created_at DESC, id DESC ROWS UNBOUNDED PRECEDING) AS newer_bytes
         FROM audit_entries WHERE body_bytes IS NOT NULL AND body_expired_at IS NULL
       ), marked AS (
         UPDATE audit_entries SET body_expired_at = $1
         WHERE body_expired_at IS NULL
           AND id IN (SELECT id FROM stored WHERE created_at < $2 OR newer_bytes > $3)
         RETURNING id
       ), removed AS (
         DELETE FROM audit_message_bodies WHERE entry_id IN (SELECT id FROM marked)
       )
       SELECT COUNT(*) AS evicted FROM marked`,
      [now.getTime(), now.getTime() - maxAgeMs, maxBodyBytes],
    );
    return { evicted: rows[0]!.evicted };
  }

  async storedBodyBytes(): Promise<number> {
    const { rows } = await this.pool.query<{ bytes: string }>(
      'SELECT COALESCE(SUM(body_bytes), 0) AS bytes FROM audit_entries WHERE body_bytes IS NOT NULL AND body_expired_at IS NULL',
    );
    return Number(rows[0]!.bytes);
  }

  async close(): Promise<void> {
    this.closing ??= this.pool.end();
    await this.closing;
  }
}
