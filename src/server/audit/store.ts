// Audit store: one Audit Entry per triage action, in SQLite (built-in
// node:sqlite) on the data volume, with numbered schema migrations.
//
// ADR 0001: a Discard writes the full Message here *before* the ack, so the
// copy must be on disk when record() returns. The store runs WAL with
// `synchronous = FULL`: every commit fsyncs the WAL (NORMAL would only fsync
// at checkpoints, and a power loss could take a committed copy with it).
//
// An entry is written as `pending` before its action touches the broker and
// updated with the outcome afterwards. The body of a Discarded Message lives
// in its own table (audit_message_bodies), so retention can evict bodies
// while the entry, its properties and headers stay forever: an evicted entry
// keeps `body_bytes` and gets `body_expired_at` ("body expired").
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fromAmqpJson, toAmqpJson } from './amqp-json.js';
import type {
  AuditEntry,
  AuditQuery,
  AuditStore as AsyncAuditStore,
  BodyEviction,
  MessageCopy,
  NewAuditEntry,
  ProfileScope,
} from './audit-store.js';
import { HistoryStore } from './history.js';
import { NotificationStore } from './notifications.js';
import { AlertStore } from './alerts.js';
import { RuleStateStore } from './rule-state.js';
import { SqliteAuditStore } from './sqlite-audit-store.js';
import type { AuditAction, AuditCanaryOutcome, AuditDestination, AuditOutcome } from '../../shared/audit.js';
import type { Filter } from '../../shared/filters.js';
import type { Role } from '../../shared/roles.js';

export type { AuditAction, AuditCanaryOutcome, AuditDestination, AuditOutcome };
export type { AuditEntry, AuditQuery, BodyEviction, MessageCopy, NewAuditEntry, ProfileScope };

/** Append-only: each entry runs once, in order, recorded in PRAGMA user_version. */
const MIGRATIONS: string[] = [
  `CREATE TABLE audit_entries (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     created_at INTEGER NOT NULL,
     operator_id TEXT NOT NULL,
     operator_name TEXT NOT NULL,
     broker_user TEXT NOT NULL,
     profile TEXT NOT NULL,
     vhost TEXT NOT NULL,
     queue TEXT NOT NULL,
     message_id TEXT,
     action TEXT NOT NULL,
     reason TEXT,
     destination_exchange TEXT,
     destination_routing_key TEXT,
     destination_queue TEXT,
     outcome TEXT NOT NULL,
     outcome_reason TEXT,
     checkout_id TEXT,
     message_properties TEXT,
     message_headers TEXT,
     body_bytes INTEGER
   );
   CREATE TABLE audit_message_bodies (
     entry_id INTEGER PRIMARY KEY REFERENCES audit_entries (id),
     body BLOB NOT NULL
   );
   CREATE INDEX audit_entries_created_at ON audit_entries (created_at);
   CREATE INDEX audit_entries_queue ON audit_entries (vhost, queue);
   CREATE INDEX audit_entries_destination_queue ON audit_entries (destination_queue);
   CREATE INDEX audit_entries_message_id ON audit_entries (message_id);
   CREATE INDEX audit_entries_checkout_id ON audit_entries (checkout_id);`,
  // v2 (#8): the replay id of a Replay or Move, to link a Message that dies again back to its entry.
  `ALTER TABLE audit_entries ADD COLUMN replay_id TEXT;
   CREATE INDEX audit_entries_replay_id ON audit_entries (replay_id);`,
  // v3 (#10): Restore links to the Discard it republished; retention marks evicted bodies.
  `ALTER TABLE audit_entries ADD COLUMN restore_of INTEGER REFERENCES audit_entries (id);
   ALTER TABLE audit_entries ADD COLUMN body_expired_at INTEGER;
   CREATE INDEX audit_entries_restore_of ON audit_entries (restore_of);
   CREATE INDEX audit_entries_stored_bodies ON audit_entries (created_at, id)
     WHERE body_bytes IS NOT NULL AND body_expired_at IS NULL;`,
  // v4 (#38): the Operator's Role on the Broker Profile; null on older entries.
  `ALTER TABLE audit_entries ADD COLUMN operator_role TEXT;`,
  // v5 (#45): the Operator who approved the Apply; null when it needed no Approval.
  `ALTER TABLE audit_entries ADD COLUMN approver_id TEXT;
   ALTER TABLE audit_entries ADD COLUMN approver_name TEXT;`,
  // v6 (#44): an export records the filter its Messages matched (JSON) and how many it holds.
  `ALTER TABLE audit_entries ADD COLUMN filter TEXT;
   ALTER TABLE audit_entries ADD COLUMN message_count INTEGER;`,
  // v7 (#56): every entry an Apply writes records its Replay Rate (Messages per second; null when there is none).
  `ALTER TABLE audit_entries ADD COLUMN rate REAL;`,
  // v8 (#63): the Replay Rule (name) and Rule Pass that wrote the entry; null for an Operator's actions.
  `ALTER TABLE audit_entries ADD COLUMN rule TEXT;
   ALTER TABLE audit_entries ADD COLUMN rule_pass_id TEXT;
   CREATE INDEX audit_entries_rule ON audit_entries (rule);`,
  // v9 (#58): the Replay an Apply carried out alone as its Canary, and how its watch ended.
  `ALTER TABLE audit_entries ADD COLUMN canary INTEGER NOT NULL DEFAULT 0;
   ALTER TABLE audit_entries ADD COLUMN canary_outcome TEXT;`,
  // v10 (#64): Replay Rule state (audit/rule-state.ts), by rule key `<profile>/<rule>`: the paused
  // flag, a bounded history of passes, and when a pass first saw each message id (bounded).
  `CREATE TABLE replay_rule_state (
     rule_key TEXT PRIMARY KEY,
     paused INTEGER NOT NULL,
     paused_reason TEXT,
     paused_by TEXT,
     paused_at INTEGER
   );
   CREATE TABLE replay_rule_passes (
     id TEXT PRIMARY KEY,
     rule_key TEXT NOT NULL,
     at INTEGER NOT NULL,
     status TEXT NOT NULL,
     reason TEXT,
     held INTEGER,
     replayed INTEGER,
     moved INTEGER,
     used_up INTEGER,
     not_due INTEGER,
     no_match INTEGER,
     failed INTEGER
   );
   CREATE INDEX replay_rule_passes_rule ON replay_rule_passes (rule_key, at);
   CREATE TABLE replay_rule_first_seen (
     rule_key TEXT NOT NULL,
     message_id TEXT NOT NULL,
     first_seen_at INTEGER NOT NULL,
     PRIMARY KEY (rule_key, message_id)
   );
   CREATE INDEX replay_rule_first_seen_at ON replay_rule_first_seen (rule_key, first_seen_at);`,
  // v11 (#65): the Died Again Messages a pass saw whose last Audit Entry is the rule's (its automatic stop), by
  // entry; and a pass's count of due Messages it could not Replay (no Replay origin).
  `CREATE TABLE replay_rule_died_again (
     rule_key TEXT NOT NULL,
     audit_entry_id INTEGER NOT NULL,
     seen_at INTEGER NOT NULL,
     PRIMARY KEY (rule_key, audit_entry_id)
   );
   ALTER TABLE replay_rule_passes ADD COLUMN cannot_replay INTEGER;`,
  // v12 (#78): the outcome of each notification to an Alert Destination.
  `CREATE TABLE notifications (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     at INTEGER NOT NULL,
     alert_id TEXT NOT NULL,
     destination TEXT NOT NULL,
     destination_type TEXT NOT NULL,
     status TEXT NOT NULL,
     test INTEGER NOT NULL,
     rule TEXT NOT NULL,
     profile TEXT,
     vhost TEXT,
     queue TEXT,
     outcome TEXT NOT NULL,
     http_status INTEGER,
     error TEXT,
     attempts INTEGER NOT NULL
   );
   CREATE INDEX notifications_at ON notifications (at);`,
  // v13 (#73): depth history (audit/history.ts), one Sample per dead-letter queue per sampling run, one
  // run per Broker Profile; and an index for the Messages taken out of a queue between two Samples.
  `CREATE TABLE history_samples (
     profile TEXT NOT NULL,
     vhost TEXT NOT NULL,
     queue TEXT NOT NULL,
     at INTEGER NOT NULL,
     depth INTEGER NOT NULL,
     estimated_arrivals INTEGER,
     PRIMARY KEY (profile, vhost, queue, at)
   ) WITHOUT ROWID;
   CREATE INDEX history_samples_at ON history_samples (at);
   CREATE TABLE sampling_runs (
     profile TEXT NOT NULL,
     at INTEGER NOT NULL,
     ok INTEGER NOT NULL,
     error_code TEXT,
     PRIMARY KEY (profile, at)
   ) WITHOUT ROWID;
   CREATE INDEX sampling_runs_at ON sampling_runs (at);
   CREATE INDEX audit_entries_profile_queue_time ON audit_entries (profile, vhost, queue, created_at);`,
  // v14 (#79): Alerts (audit/alerts.ts), so a restart neither forgets nor re-sends a firing one; and what
  // arrival conditions remember of each queue. '' stands for no vhost or queue, in the keys.
  `CREATE TABLE alerts (
     profile TEXT NOT NULL,
     rule TEXT NOT NULL,
     vhost TEXT NOT NULL,
     queue TEXT NOT NULL,
     alert_id TEXT NOT NULL,
     status TEXT NOT NULL,
     condition TEXT NOT NULL,
     value REAL,
     threshold REAL,
     since INTEGER NOT NULL,
     last_notified_at INTEGER,
     false_since INTEGER,
     PRIMARY KEY (profile, rule, vhost, queue)
   ) WITHOUT ROWID;
   CREATE TABLE alert_queue_arrivals (
     profile TEXT NOT NULL,
     vhost TEXT NOT NULL,
     queue TEXT NOT NULL,
     unsettled INTEGER NOT NULL,
     recent TEXT NOT NULL,
     PRIMARY KEY (profile, vhost, queue)
   ) WITHOUT ROWID;`,
  // v15 (#80): Alert Rules on Volverán itself. A replayRulePaused rule has one Alert per Replay Rule, so
  // that joins the key ('' for none), and an Alert keeps why its condition holds.
  `CREATE TABLE alerts_v15 (
     profile TEXT NOT NULL,
     rule TEXT NOT NULL,
     vhost TEXT NOT NULL,
     queue TEXT NOT NULL,
     replay_rule TEXT NOT NULL,
     alert_id TEXT NOT NULL,
     status TEXT NOT NULL,
     condition TEXT NOT NULL,
     value REAL,
     threshold REAL,
     since INTEGER NOT NULL,
     last_notified_at INTEGER,
     false_since INTEGER,
     reason TEXT,
     PRIMARY KEY (profile, rule, vhost, queue, replay_rule)
   ) WITHOUT ROWID;
   INSERT INTO alerts_v15 (profile, rule, vhost, queue, replay_rule, alert_id, status, condition, value, threshold, since, last_notified_at, false_since)
     SELECT profile, rule, vhost, queue, '', alert_id, status, condition, value, threshold, since, last_notified_at, false_since FROM alerts;
   DROP TABLE alerts;
   ALTER TABLE alerts_v15 RENAME TO alerts;`,
  // v16: the sampling interval each run ran at, so a later setting does not rewrite old history's gaps; and
  // the Replay Rule of a notification. Rows from before stay NULL.
  `ALTER TABLE sampling_runs ADD COLUMN interval_ms INTEGER;
   ALTER TABLE notifications ADD COLUMN replay_rule TEXT;`,
];

export const AUDIT_DB_FILE = 'audit.sqlite';

export class AuditStore {
  private readonly db: DatabaseSync;
  /** The state of the Replay Rules, in the same database. */
  readonly ruleState: RuleStateStore;
  /** Depth history, in the same database. */
  readonly history: HistoryStore;
  /** The outcomes of notifications, in the same database. */
  readonly notifications: NotificationStore;
  /** Alerts, in the same database. */
  readonly alerts: AlertStore;
  /** The asynchronous form of this store, on the same connection (ADR 0013). Callers move to it one by one. */
  readonly async: AsyncAuditStore;

  /**
   * Opens (creating if needed) the audit store in `dataDir`. Without a
   * directory the store lives in memory only (tests).
   */
  constructor(dataDir?: string) {
    if (dataDir) mkdirSync(dataDir, { recursive: true });
    this.db = new DatabaseSync(dataDir ? path.join(dataDir, AUDIT_DB_FILE) : ':memory:');
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL; PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON;');
    this.migrate();
    this.ruleState = new RuleStateStore(this.db);
    this.history = new HistoryStore(this.db);
    this.notifications = new NotificationStore(this.db);
    this.alerts = new AlertStore(this.db);
    this.async = new SqliteAuditStore(this);
  }

  /** Writes a `pending` entry (and its body, if any) in one durable commit; returns its id. */
  record(entry: NewAuditEntry): number {
    const { message, destination } = entry;
    this.db.exec('BEGIN');
    try {
      const result = this.db
        .prepare(
          `INSERT INTO audit_entries (created_at, operator_id, operator_name, broker_user, profile, vhost, queue,
             message_id, action, reason, destination_exchange, destination_routing_key, destination_queue,
             outcome, checkout_id, message_properties, message_headers, body_bytes, replay_id, restore_of, operator_role,
             approver_id, approver_name,
             filter, message_count, rate, rule, rule_pass_id, canary)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          entry.at.getTime(),
          entry.operator.id,
          entry.operator.displayName,
          entry.brokerUser,
          entry.profile,
          entry.vhost,
          entry.queue,
          entry.messageId,
          entry.action,
          entry.reason,
          destination?.exchange ?? null,
          destination?.routingKey ?? null,
          destination?.queue ?? null,
          entry.checkoutId,
          message ? JSON.stringify(toAmqpJson(message.properties)) : null,
          message ? JSON.stringify(toAmqpJson(message.headers)) : null,
          message?.body ? message.body.length : null,
          entry.replayId ?? null,
          entry.restoreOf ?? null,
          entry.role ?? null,
          entry.approver?.id ?? null,
          entry.approver?.displayName ?? null,
          entry.filter ? JSON.stringify(entry.filter) : null,
          entry.messageCount ?? null,
          entry.rate ?? null,
          entry.rule ?? null,
          entry.rulePassId ?? null,
          entry.canary ? 1 : 0,
        );
      const id = Number(result.lastInsertRowid);
      if (message?.body) {
        this.db.prepare('INSERT INTO audit_message_bodies (entry_id, body) VALUES (?, ?)').run(id, message.body);
      }
      this.db.exec('COMMIT');
      return id;
    } catch (err) {
      if (this.db.isTransaction) this.db.exec('ROLLBACK');
      throw err;
    }
  }

  setOutcome(id: number, outcome: Exclude<AuditOutcome, 'pending'>, reason: string | null = null): void {
    this.db.prepare('UPDATE audit_entries SET outcome = ?, outcome_reason = ? WHERE id = ?').run(outcome, reason, id);
  }

  /** Records how the watch of a Canary's entry ended. */
  setCanaryOutcome(id: number, outcome: AuditCanaryOutcome): void {
    this.db.prepare('UPDATE audit_entries SET canary_outcome = ? WHERE id = ?').run(outcome, id);
  }

  /** The entries matching `query` (every entry by default), newest first. */
  list(query: AuditQuery = {}): AuditEntry[] {
    const where: string[] = [];
    const params: Array<string | number> = [];
    const match = (sql: string, ...values: Array<string | number>) => {
      where.push(sql);
      params.push(...values);
    };
    if (query.queue !== undefined) match('(queue = ? OR destination_queue = ?)', query.queue, query.queue);
    if (query.messageId !== undefined) match('message_id = ?', query.messageId);
    if (query.action !== undefined) match('action = ?', query.action);
    if (query.checkoutId !== undefined) match('checkout_id = ?', query.checkoutId);
    if (query.replayId !== undefined) match('replay_id = ?', query.replayId);
    if (query.profile !== undefined) match('profile = ?', query.profile);
    const scope = query.profiles;
    if (scope && 'only' in scope) {
      match(scope.only.length ? `profile IN (${scope.only.map(() => '?').join(', ')})` : '0', ...scope.only);
    } else if (scope?.except.length) {
      match(`profile NOT IN (${scope.except.map(() => '?').join(', ')})`, ...scope.except);
    }
    if (query.operator !== undefined) match('(operator_id = ? OR operator_name = ?)', query.operator, query.operator);
    if (query.restoreOf !== undefined) match('restore_of = ?', query.restoreOf);
    if (query.rule !== undefined) match('rule = ?', query.rule);
    if (query.from !== undefined) match('created_at >= ?', query.from.getTime());
    if (query.to !== undefined) match('created_at <= ?', query.to.getTime());
    let sql = 'SELECT * FROM audit_entries';
    if (where.length) sql += ` WHERE ${where.join(' AND ')}`;
    sql += ' ORDER BY created_at DESC, id DESC';
    if (query.limit !== undefined) {
      sql += ' LIMIT ?';
      params.push(query.limit);
    }
    return this.db
      .prepare(sql)
      .all(...params)
      .map((row) => toEntry(row as unknown as Row));
  }

  /** One entry, or null. */
  get(id: number): AuditEntry | null {
    const row = this.db.prepare('SELECT * FROM audit_entries WHERE id = ?').get(id);
    return row ? toEntry(row as unknown as Row) : null;
  }

  /** The stored body of entry `id`'s Message, byte for byte; null when none is stored. */
  body(id: number): Buffer | null {
    const row = this.db.prepare('SELECT body FROM audit_message_bodies WHERE entry_id = ?').get(id) as
      | { body: Uint8Array }
      | undefined;
    return row ? Buffer.from(row.body) : null;
  }

  /**
   * Evicts stored bodies, oldest first: those older than `maxAgeMs`, then
   * as many more as needed for the rest to fit in `maxBodyBytes`. Each
   * evicted entry keeps everything else and is marked body expired at `now`.
   */
  evictBodies({ now, maxAgeMs, maxBodyBytes }: BodyEviction): { evicted: number } {
    // `newer_bytes`: this body plus every newer one. The newest bodies that
    // fit are kept; anything older, or older than the age limit, goes.
    const ids = this.db
      .prepare(
        `SELECT id FROM (
           SELECT id, created_at,
                  SUM(body_bytes) OVER (ORDER BY created_at DESC, id DESC ROWS UNBOUNDED PRECEDING) AS newer_bytes
           FROM audit_entries WHERE body_bytes IS NOT NULL AND body_expired_at IS NULL
         ) WHERE created_at < ? OR newer_bytes > ?`,
      )
      .all(now.getTime() - maxAgeMs, maxBodyBytes)
      .map((row) => Number((row as { id: number }).id));
    if (ids.length === 0) return { evicted: 0 };
    this.db.exec('BEGIN');
    try {
      const mark = this.db.prepare('UPDATE audit_entries SET body_expired_at = ? WHERE id = ?');
      const remove = this.db.prepare('DELETE FROM audit_message_bodies WHERE entry_id = ?');
      for (const id of ids) {
        mark.run(now.getTime(), id);
        remove.run(id);
      }
      this.db.exec('COMMIT');
    } catch (err) {
      if (this.db.isTransaction) this.db.exec('ROLLBACK');
      throw err;
    }
    return { evicted: ids.length };
  }

  /** The total size of the bodies stored now (what the size limit applies to). */
  storedBodyBytes(): number {
    const row = this.db
      .prepare(
        'SELECT COALESCE(SUM(body_bytes), 0) AS bytes FROM audit_entries WHERE body_bytes IS NOT NULL AND body_expired_at IS NULL',
      )
      .get() as { bytes: number };
    return Number(row.bytes);
  }

  close(): void {
    if (this.db.isOpen) this.db.close();
  }

  private migrate() {
    const version = Number((this.db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version);
    for (let v = version; v < MIGRATIONS.length; v++) {
      this.db.exec('BEGIN');
      try {
        this.db.exec(MIGRATIONS[v]!);
        this.db.exec(`PRAGMA user_version = ${v + 1}`);
        this.db.exec('COMMIT');
      } catch (err) {
        this.db.exec('ROLLBACK');
        throw err;
      }
    }
  }
}

interface Row {
  id: number;
  created_at: number;
  operator_id: string;
  operator_name: string;
  broker_user: string;
  profile: string;
  vhost: string;
  queue: string;
  message_id: string | null;
  action: AuditAction;
  reason: string | null;
  destination_exchange: string | null;
  destination_routing_key: string | null;
  destination_queue: string | null;
  outcome: AuditOutcome;
  outcome_reason: string | null;
  checkout_id: string | null;
  message_properties: string | null;
  message_headers: string | null;
  body_bytes: number | null;
  replay_id: string | null;
  restore_of: number | null;
  body_expired_at: number | null;
  operator_role: Role | null;
  approver_id: string | null;
  approver_name: string | null;
  filter: string | null;
  message_count: number | null;
  rate: number | null;
  rule: string | null;
  rule_pass_id: string | null;
  canary: number;
  canary_outcome: AuditCanaryOutcome | null;
}

function toEntry(row: Row): AuditEntry {
  return {
    id: row.id,
    at: new Date(row.created_at),
    operatorId: row.operator_id,
    operatorName: row.operator_name,
    role: row.operator_role,
    approverId: row.approver_id,
    approverName: row.approver_name,
    brokerUser: row.broker_user,
    profile: row.profile,
    vhost: row.vhost,
    queue: row.queue,
    messageId: row.message_id,
    action: row.action,
    reason: row.reason,
    destination:
      row.destination_routing_key === null
        ? null
        : {
            exchange: row.destination_exchange ?? '',
            routingKey: row.destination_routing_key,
            queue: row.destination_queue,
          },
    outcome: row.outcome,
    outcomeReason: row.outcome_reason,
    checkoutId: row.checkout_id,
    replayId: row.replay_id,
    restoreOf: row.restore_of,
    bodyExpiredAt: row.body_expired_at === null ? null : new Date(row.body_expired_at),
    filter: row.filter === null ? null : (JSON.parse(row.filter) as Filter),
    messageCount: row.message_count,
    rate: row.rate,
    rule: row.rule,
    rulePassId: row.rule_pass_id,
    canary: row.canary === 1,
    canaryOutcome: row.canary_outcome,
    message:
      row.message_properties === null
        ? null
        : {
            properties: fromAmqpJson(JSON.parse(row.message_properties)) as Record<string, unknown>,
            headers: fromAmqpJson(JSON.parse(row.message_headers ?? '{}')) as Record<string, unknown>,
            bodyBytes: row.body_bytes,
          },
  };
}
