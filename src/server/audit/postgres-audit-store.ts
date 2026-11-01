// The audit store interface on PostgreSQL (ADR 0013). The pool is bounded, and a call
// of several statements runs on one connection, in one transaction (`transaction`).
// A commit is durable when its promise resolves, as ADR 0001 needs of `record`:
// every connection sets `synchronous_commit` to `on` (createPool).
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
  ReplicaStore,
  RuleStateStore,
  SessionStore,
} from './audit-store.js';
import { ConfigError } from '../config-error.js';
import { asStartupError, createPool, numbered, refusalAsStartupError, transaction, type PostgresTls } from './postgres-connection.js';
import { migrate } from './postgres-migrations.js';
import { PostgresAlertStore } from './postgres-alerts.js';
import { PostgresHistoryStore } from './postgres-history.js';
import { PostgresNotificationStore } from './postgres-notifications.js';
import { PostgresReplicaStore } from './postgres-replicas.js';
import { PostgresRuleStateStore } from './postgres-rule-state.js';
import { PostgresSessionStore } from './postgres-sessions.js';
import type { AuditCanaryOutcome, AuditOutcome } from '../../shared/audit.js';

/** Under the chart's readiness probe timeout, so a probe gets an answer and not a timeout. */
const PING_TIMEOUT_MS = 2_000;

/** TEXT holds every string Volverán keeps only on UTF8: another encoding could reject one in the middle of an Apply. */
async function refuseOtherEncodings(pool: pg.Pool): Promise<void> {
  const { rows } = await pool.query<{ encoding: string; database: string }>(
    'SELECT pg_encoding_to_char(encoding) AS encoding, datname AS database FROM pg_database WHERE datname = current_database()',
  );
  const { encoding, database } = rows[0]!;
  if (encoding !== 'UTF8') {
    throw new ConfigError(`The PostgreSQL database "${database}" is encoded in ${encoding}, and Volverán needs UTF8: a Message's headers or an Operator's reason could be refused. Create the database with ENCODING 'UTF8'.`);
  }
}

export class PostgresAuditStore implements AuditStore {
  readonly ruleState: RuleStateStore;
  readonly history: HistoryStore;
  readonly notifications: NotificationStore;
  readonly alerts: AlertStore;
  readonly sessions: SessionStore;
  readonly replicas: ReplicaStore;
  private closing: Promise<void> | undefined;
  private pinging: Promise<void> | undefined;

  private constructor(private readonly pool: pg.Pool) {
    this.ruleState = new PostgresRuleStateStore(pool);
    this.history = new PostgresHistoryStore(pool);
    this.notifications = new PostgresNotificationStore(pool);
    this.alerts = new PostgresAlertStore(pool);
    this.sessions = new PostgresSessionStore(pool);
    this.replicas = new PostgresReplicaStore(pool);
  }

  /**
   * Connects to the database at `url` and brings its schema up to date. Refuses a store
   * newer than this version, and says clearly (a ConfigError) why it cannot use the database.
   */
  static async open(url: string, tls?: PostgresTls | null): Promise<PostgresAuditStore> {
    const pools: pg.Pool[] = [];
    try {
      const pool = createPool(url, { tls });
      pools.push(pool);
      await refuseOtherEncodings(pool);
      // A migration may take long, or wait long for the advisory lock.
      const migrating = createPool(url, { tls, queryTimeoutMs: null, max: 1 });
      pools.push(migrating);
      await migrate(migrating);
      await migrating.end();
      return new PostgresAuditStore(pool);
    } catch (err) {
      await Promise.all(pools.map((pool) => pool.end().catch(() => {})));
      throw asStartupError(err, url);
    }
  }

  /** A failure of startup after the store opened, as a ConfigError when PostgreSQL refused: a permission missing on a table only shows when it is first read. */
  static startupFailure(err: unknown, url: string): unknown {
    return refusalAsStartupError(err, url);
  }

  async record(entry: NewAuditEntry): Promise<number> {
    const { sql, values } = insertEntry(entry, numbered);
    return transaction(this.pool, async (client) => {
      const { rows } = await client.query<{ id: number }>(`${sql} RETURNING id`, values);
      const { id } = rows[0]!;
      const body = entry.message?.body;
      if (body) await client.query('INSERT INTO audit_message_bodies (entry_id, body) VALUES ($1, $2)', [id, body]);
      return id;
    });
  }

  async setOutcome(id: number, outcome: Exclude<AuditOutcome, 'pending'>, reason: string | null = null): Promise<void> {
    await this.pool.query('UPDATE audit_entries SET outcome = $1, outcome_reason = $2 WHERE id = $3', [outcome, reason, id]);
  }

  async setCanaryOutcome(id: number, outcome: AuditCanaryOutcome): Promise<void> {
    await this.pool.query('UPDATE audit_entries SET canary_outcome = $1 WHERE id = $2', [outcome, id]);
  }

  async list(query: AuditQuery = {}): Promise<AuditEntry[]> {
    const { sql, values } = searchEntries(query, numbered);
    const { rows } = await this.pool.query<EntryRow>(sql, values);
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

  /** Answers within its timeout whatever the database does. Probes that come together share one query. */
  ping(): Promise<void> {
    this.pinging ??= new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`PostgreSQL did not answer within ${PING_TIMEOUT_MS} ms`)), PING_TIMEOUT_MS);
      this.pool.query('SELECT 1').then(
        () => resolve(),
        (err: Error) => reject(err),
      ).finally(() => clearTimeout(timer));
    }).finally(() => {
      this.pinging = undefined;
    });
    return this.pinging;
  }

  async close(): Promise<void> {
    this.closing ??= this.pool.end();
    await this.closing;
  }
}
