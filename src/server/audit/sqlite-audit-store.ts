// The audit store interface on SQLite (ADR 0013): one Audit Entry per triage action,
// in built-in node:sqlite on the data volume, with numbered schema migrations.
// node:sqlite is synchronous, so each call does all its work, transaction included,
// before it answers: no other call can land inside one. Being `async`, a call turns
// a failure into a rejection. The sqlite-*.ts sub-stores work the same way.
//
// ADR 0001: a Discard writes the full Message here *before* the ack, so the
// copy must be on disk when record() resolves. The store runs WAL with
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
import { insertEntry, searchEntries, toEntry, type EntryRow } from './audit-entry-sql.js';
import type {
  AlertStore,
  AuditEntry,
  AuditQuery,
  AuditStore,
  BodyEviction, LeaseFence,
  HistoryStore,
  NewAuditEntry,
  NotificationStore,
  RuleStateStore,
  ReplicaStore,
  SessionStore,
} from './audit-store.js';
import { MemoryLeaderLease } from './memory-leader-lease.js';
import { MemoryReplicaStore } from './memory-replicas.js';
import { MemorySessionStore } from './memory-sessions.js';
import { SqliteAlertStore } from './sqlite-alerts.js';
import { SqliteHistoryStore } from './sqlite-history.js';
import { SqliteNotificationStore } from './sqlite-notifications.js';
import { SqliteRuleStateStore } from './sqlite-rule-state.js';
import { refuseNewerStore } from './store-version.js';
import type { AuditCanaryOutcome, AuditOutcome } from '../../shared/audit.js';

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
  // v10 (#64): Replay Rule state (audit/sqlite-rule-state.ts), by rule key `<profile>/<rule>`: the paused
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
  // v13 (#73): depth history (audit/sqlite-history.ts), one Sample per dead-letter queue per sampling run, one
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
  // v14 (#79): Alerts (audit/sqlite-alerts.ts), so a restart neither forgets nor re-sends a firing one; and what
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
  // v17 (#99): passes of the same moment are ordered by an explicit sequence, as on PostgreSQL, not by rowid.
  `CREATE TABLE replay_rule_passes_v17 (
     seq INTEGER PRIMARY KEY AUTOINCREMENT,
     id TEXT NOT NULL UNIQUE,
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
     failed INTEGER,
     cannot_replay INTEGER
   );
   INSERT INTO replay_rule_passes_v17 (id, rule_key, at, status, reason, held, replayed, moved, used_up, not_due, no_match, failed, cannot_replay)
     SELECT id, rule_key, at, status, reason, held, replayed, moved, used_up, not_due, no_match, failed, cannot_replay
     FROM replay_rule_passes ORDER BY rowid;
   DROP TABLE replay_rule_passes;
   ALTER TABLE replay_rule_passes_v17 RENAME TO replay_rule_passes;
   CREATE INDEX replay_rule_passes_rule ON replay_rule_passes (rule_key, at);`,
];

export const AUDIT_DB_FILE = 'audit.sqlite';

export class SqliteAuditStore implements AuditStore {
  private readonly db: DatabaseSync;
  readonly ruleState: RuleStateStore;
  readonly history: HistoryStore;
  readonly notifications: NotificationStore;
  readonly alerts: AlertStore;
  readonly sessions: SessionStore = new MemorySessionStore();
  readonly leaderLease = new MemoryLeaderLease();
  readonly replicas: ReplicaStore = new MemoryReplicaStore();

  /**
   * Opens (creating if needed) the audit store in `dataDir`. Without a
   * directory the store lives in memory only (tests).
   */
  constructor(dataDir?: string) {
    if (dataDir) mkdirSync(dataDir, { recursive: true });
    this.db = new DatabaseSync(dataDir ? path.join(dataDir, AUDIT_DB_FILE) : ':memory:');
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL; PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON;');
    try {
      this.migrate();
    } catch (err) {
      this.db.close();
      throw err;
    }
    this.ruleState = new SqliteRuleStateStore(this.db);
    this.history = new SqliteHistoryStore(this.db, this.leaderLease);
    this.notifications = new SqliteNotificationStore(this.db, this.leaderLease);
    this.alerts = new SqliteAlertStore(this.db, this.leaderLease);
  }

  /** Writes a `pending` entry (and its body, if any) in one durable commit; returns its id. */
  async record(entry: NewAuditEntry): Promise<number> {
    const { message } = entry;
    const { sql, values } = insertEntry(entry, () => '?');
    this.db.exec('BEGIN');
    try {
      const result = this.db.prepare(sql).run(...values);
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

  async setOutcome(id: number, outcome: Exclude<AuditOutcome, 'pending'>, reason: string | null = null): Promise<void> {
    this.db.prepare('UPDATE audit_entries SET outcome = ?, outcome_reason = ? WHERE id = ?').run(outcome, reason, id);
  }

  async settleInterrupted(checkoutId: string, reason: string): Promise<number> {
    const { changes } = this.db.prepare("UPDATE audit_entries SET outcome = 'uncertain', outcome_reason = ? WHERE checkout_id = ? AND outcome = 'pending'").run(reason, checkoutId);
    return Number(changes);
  }

  /** Records how the watch of a Canary's entry ended. */
  async setCanaryOutcome(id: number, outcome: AuditCanaryOutcome): Promise<void> {
    this.db.prepare('UPDATE audit_entries SET canary_outcome = ? WHERE id = ?').run(outcome, id);
  }

  /** The entries matching `query` (every entry by default), newest first. */
  async list(query: AuditQuery = {}): Promise<AuditEntry[]> {
    const { sql, values } = searchEntries(query, () => '?');
    return this.db
      .prepare(sql)
      .all(...values)
      .map((row) => toEntry(row as unknown as EntryRow));
  }

  /** One entry, or null. */
  async get(id: number): Promise<AuditEntry | null> {
    const row = this.db.prepare('SELECT * FROM audit_entries WHERE id = ?').get(id);
    return row ? toEntry(row as unknown as EntryRow) : null;
  }

  /** The stored body of entry `id`'s Message, byte for byte; null when none is stored. */
  async body(id: number): Promise<Buffer | null> {
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
  async evictBodies({ now, maxAgeMs, maxBodyBytes }: BodyEviction, fence?: LeaseFence): Promise<{ evicted: number }> {
    this.leaderLease.check(fence);
    // `newer_bytes`: this body plus every newer one. The newest bodies that
    // fit are kept; anything older, or older than the age limit, goes.
    const ids = this.db
      .prepare(
        `SELECT id FROM (
           SELECT id, created_at,
                  SUM(body_bytes) OVER (ORDER BY created_at DESC, id DESC ROWS UNBOUNDED PRECEDING) AS newer_bytes
           FROM audit_entries WHERE body_bytes IS NOT NULL AND body_expired_at IS NULL
         ) AS stored WHERE created_at < ? OR newer_bytes > ?`,
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
  async storedBodyBytes(): Promise<number> {
    const row = this.db
      .prepare(
        'SELECT COALESCE(SUM(body_bytes), 0) AS bytes FROM audit_entries WHERE body_bytes IS NOT NULL AND body_expired_at IS NULL',
      )
      .get() as { bytes: number };
    return Number(row.bytes);
  }

  /** A file on the pod's own volume, so nothing can come between the process and it. */
  async ping(): Promise<void> {}

  async close(): Promise<void> {
    if (this.db.isOpen) this.db.close();
  }

  private migrate() {
    const version = Number((this.db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version);
    refuseNewerStore(version, MIGRATIONS.length);
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
