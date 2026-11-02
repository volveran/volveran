// Replay Rule state in the audit store (migration v10), so a restart neither
// resumes a paused rule nor forgets its passes. Keyed by rule key
// `<profile>/<rule>`. A rule removed from the profiles file is simply no
// longer asked about; its rows stay, like its Audit Entries.
//
// - The paused flag, with why, by whom and when (#65 pauses and resumes).
//   A rule without a row has never started; `ensure` creates its row.
// - Its last passes, at most PASS_HISTORY per rule (the oldest go).
// - When a pass first saw each message id: the back-off's last fallback for
//   when a Message was dead-lettered, at most FIRST_SEEN_LIMIT per rule.
// - The Died Again Messages its passes saw whose last Audit Entry is the
//   rule's, by that entry and when first seen: the count of the automatic
//   stop. Only the stop's window is kept; a resume clears them.
import type { DatabaseSync } from 'node:sqlite';
import type { RulePass, RuleState } from '../../shared/replay-rules.js';
import { insertEntry } from './audit-entry-sql.js';
import { FIRST_SEEN_LIMIT, PASS_HISTORY, type LeaseFence, type RulePauseEntry, type RuleStateStore } from './audit-store.js';
import type { MemoryLeaderLease } from './memory-leader-lease.js';
import { toPass, toRuleState, type PassRow, type RuleStateRow } from './store-rows.js';

export class SqliteRuleStateStore implements RuleStateStore {
  constructor(
    private readonly db: DatabaseSync,
    private readonly lease: MemoryLeaderLease,
  ) {}

  /** The rule's state; creates it (paused when `startPaused`) the first time the rule is seen, after which the stored state wins. */
  async ensure(ruleKey: string, startPaused: boolean): Promise<RuleState> {
    this.db
      .prepare('INSERT INTO replay_rule_state (rule_key, paused) VALUES (?, ?) ON CONFLICT (rule_key) DO NOTHING')
      .run(ruleKey, startPaused ? 1 : 0);
    return this.read(ruleKey)!;
  }

  /** The rule's state; null when it has never started. */
  async state(ruleKey: string): Promise<RuleState | null> {
    return this.read(ruleKey);
  }

  private read(ruleKey: string): RuleState | null {
    const row = this.db.prepare('SELECT * FROM replay_rule_state WHERE rule_key = ?').get(ruleKey) as RuleStateRow | undefined;
    return row ? toRuleState(row) : null;
  }

  async pause(ruleKey: string, pause: { reason: string; by: string; at: Date }, entry: RulePauseEntry): Promise<boolean> {
    return this.inTransaction(() => {
      if (!this.setPaused(ruleKey, pause)) return false;
      this.writeDoneEntry(entry);
      return true;
    });
  }

  async resume(ruleKey: string, entry: RulePauseEntry): Promise<boolean> {
    return this.inTransaction(() => {
      if (!this.setPaused(ruleKey, null)) return false;
      this.db.prepare('DELETE FROM replay_rule_died_again WHERE rule_key = ?').run(ruleKey);
      this.writeDoneEntry(entry);
      return true;
    });
  }

  async nextPass(ruleKey: string): Promise<Date | null> {
    const row = this.db.prepare('SELECT next_pass_at FROM replay_rule_state WHERE rule_key = ?').get(ruleKey) as { next_pass_at: number | null } | undefined;
    return row?.next_pass_at == null ? null : new Date(Number(row.next_pass_at));
  }

  async setNextPass(ruleKey: string, at: Date | null, fence?: LeaseFence): Promise<void> {
    this.lease.check(fence);
    const ms = at?.getTime() ?? null;
    this.db.prepare('UPDATE replay_rule_state SET next_pass_at = ? WHERE rule_key = ? AND (paused = 0 OR ? IS NULL)').run(ms, ruleKey, ms);
  }

  private inTransaction<T>(work: () => T): T {
    this.db.exec('BEGIN');
    try {
      const result = work();
      this.db.exec('COMMIT');
      return result;
    } catch (err) {
      if (this.db.isTransaction) this.db.exec('ROLLBACK');
      throw err;
    }
  }

  /** Answers whether it changed anything: a rule already as asked stays as it is. */
  private setPaused(ruleKey: string, pause: { reason: string; by: string; at: Date } | null): boolean {
    const { changes } = this.db
      .prepare(
        `INSERT INTO replay_rule_state (rule_key, paused, paused_reason, paused_by, paused_at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (rule_key) DO UPDATE SET paused = excluded.paused, paused_reason = excluded.paused_reason,
           paused_by = excluded.paused_by, paused_at = excluded.paused_at, next_pass_at = NULL
         WHERE replay_rule_state.paused <> excluded.paused`,
      )
      .run(ruleKey, pause ? 1 : 0, pause?.reason ?? null, pause?.by ?? null, pause?.at.getTime() ?? null);
    return Number(changes) === 1;
  }

  private writeDoneEntry(entry: RulePauseEntry): void {
    const { sql, values } = insertEntry(entry, () => '?');
    const { lastInsertRowid } = this.db.prepare(sql).run(...values);
    this.db.prepare(`UPDATE audit_entries SET outcome = 'done' WHERE id = ?`).run(lastInsertRowid);
  }

  /** Keeps `pass` in the rule's history, dropping the oldest beyond PASS_HISTORY. */
  async recordPass(ruleKey: string, pass: RulePass): Promise<void> {
    const s = pass.summary;
    this.db.exec('BEGIN');
    try {
      this.db
        .prepare(
          `INSERT INTO replay_rule_passes (id, rule_key, at, status, reason, held, replayed, moved, used_up, not_due, no_match, cannot_replay, failed)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          pass.id,
          ruleKey,
          Date.parse(pass.at),
          pass.status,
          pass.reason,
          s?.held ?? null,
          s?.replayed ?? null,
          s?.moved ?? null,
          s?.usedUp ?? null,
          s?.notDue ?? null,
          s?.noMatch ?? null,
          s?.cannotReplay ?? null,
          s?.failed ?? null,
        );
      this.db
        .prepare(
          `DELETE FROM replay_rule_passes WHERE rule_key = ? AND id NOT IN (
             SELECT id FROM replay_rule_passes WHERE rule_key = ? ORDER BY at DESC, seq DESC LIMIT ?)`,
        )
        .run(ruleKey, ruleKey, PASS_HISTORY);
      this.db.exec('COMMIT');
    } catch (err) {
      if (this.db.isTransaction) this.db.exec('ROLLBACK');
      throw err;
    }
  }

  /** The rule's kept passes, newest first. */
  async passes(ruleKey: string): Promise<RulePass[]> {
    const rows = this.db
      .prepare('SELECT * FROM replay_rule_passes WHERE rule_key = ? ORDER BY at DESC, seq DESC')
      .all(ruleKey) as unknown as PassRow[];
    return rows.map(toPass);
  }

  /**
   * When a pass of the rule first saw each of `messageIds`: the stored time,
   * or `now` for an id not seen before (which is stored, dropping the oldest
   * beyond FIRST_SEEN_LIMIT).
   */
  async firstSeen(ruleKey: string, messageIds: readonly string[], now: Date): Promise<Map<string, Date>> {
    const seen = new Map<string, Date>();
    if (messageIds.length === 0) return seen;
    this.db.exec('BEGIN');
    try {
      const insert = this.db.prepare(
        'INSERT INTO replay_rule_first_seen (rule_key, message_id, first_seen_at) VALUES (?, ?, ?) ON CONFLICT DO NOTHING',
      );
      const read = this.db.prepare('SELECT first_seen_at FROM replay_rule_first_seen WHERE rule_key = ? AND message_id = ?');
      for (const id of new Set(messageIds)) {
        insert.run(ruleKey, id, now.getTime());
        seen.set(id, new Date(Number((read.get(ruleKey, id) as { first_seen_at: number }).first_seen_at)));
      }
      this.db
        .prepare(
          `DELETE FROM replay_rule_first_seen WHERE rule_key = ? AND message_id NOT IN (
             SELECT message_id FROM replay_rule_first_seen WHERE rule_key = ? ORDER BY first_seen_at DESC LIMIT ?)`,
        )
        .run(ruleKey, ruleKey, FIRST_SEEN_LIMIT);
      this.db.exec('COMMIT');
    } catch (err) {
      if (this.db.isTransaction) this.db.exec('ROLLBACK');
      throw err;
    }
    return seen;
  }

  /**
   * Notes the Died Again Messages a pass of the rule saw at `now`, by the
   * Audit Entry each last came from; only entries of this rule (`profile`,
   * `rule`) count, and each counts once. Forgets those seen before `since`
   * and answers how many are left: the count of the automatic stop.
   */
  async countDiedAgain(ruleKey: string, rule: { profile: string; name: string }, auditEntryIds: readonly number[], now: Date, since: Date): Promise<number> {
    this.db.exec('BEGIN');
    try {
      const insert = this.db.prepare(
        `INSERT INTO replay_rule_died_again (rule_key, audit_entry_id, seen_at)
         SELECT ?, id, ? FROM audit_entries WHERE id = ? AND profile = ? AND rule = ?
         ON CONFLICT DO NOTHING`,
      );
      for (const id of new Set(auditEntryIds)) insert.run(ruleKey, now.getTime(), id, rule.profile, rule.name);
      this.db.prepare('DELETE FROM replay_rule_died_again WHERE rule_key = ? AND seen_at < ?').run(ruleKey, since.getTime());
      const { n } = this.db.prepare('SELECT COUNT(*) AS n FROM replay_rule_died_again WHERE rule_key = ?').get(ruleKey) as { n: number };
      this.db.exec('COMMIT');
      return Number(n);
    } catch (err) {
      if (this.db.isTransaction) this.db.exec('ROLLBACK');
      throw err;
    }
  }

  /** When a pass of the rule first saw each of `messageIds`, without storing anything; an id none has seen is left out. */
  async firstSeenAt(ruleKey: string, messageIds: readonly string[]): Promise<Map<string, Date>> {
    const read = this.db.prepare('SELECT first_seen_at FROM replay_rule_first_seen WHERE rule_key = ? AND message_id = ?');
    const seen = new Map<string, Date>();
    for (const id of new Set(messageIds)) {
      const row = read.get(ruleKey, id) as { first_seen_at: number } | undefined;
      if (row) seen.set(id, new Date(Number(row.first_seen_at)));
    }
    return seen;
  }
}
