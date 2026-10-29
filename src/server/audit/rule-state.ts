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
import type { DatabaseSync } from 'node:sqlite';
import type { RulePass, RulePassStatus, RuleState } from '../../shared/replay-rules.js';

/** How many passes a rule keeps. */
export const PASS_HISTORY = 20;
/** How many first-seen times a rule keeps (the oldest go). */
export const FIRST_SEEN_LIMIT = 10_000;

export class RuleStateStore {
  constructor(private readonly db: DatabaseSync) {}

  /** The rule's state; creates it (paused when `startPaused`) the first time the rule is seen, after which the stored state wins. */
  ensure(ruleKey: string, startPaused: boolean): RuleState {
    this.db
      .prepare('INSERT INTO replay_rule_state (rule_key, paused) VALUES (?, ?) ON CONFLICT (rule_key) DO NOTHING')
      .run(ruleKey, startPaused ? 1 : 0);
    return this.state(ruleKey)!;
  }

  /** The rule's state; null when it has never started. */
  state(ruleKey: string): RuleState | null {
    const row = this.db.prepare('SELECT * FROM replay_rule_state WHERE rule_key = ?').get(ruleKey) as StateRow | undefined;
    if (!row) return null;
    return {
      paused: row.paused === 1,
      pausedReason: row.paused_reason,
      pausedBy: row.paused_by,
      pausedAt: row.paused_at === null ? null : new Date(row.paused_at).toISOString(),
    };
  }

  /** Pauses the rule (`reason`, `by`, `at`) or, with null, lets it run again. */
  setPaused(ruleKey: string, pause: { reason: string; by: string; at: Date } | null): void {
    this.db
      .prepare(
        `INSERT INTO replay_rule_state (rule_key, paused, paused_reason, paused_by, paused_at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (rule_key) DO UPDATE SET paused = excluded.paused, paused_reason = excluded.paused_reason,
           paused_by = excluded.paused_by, paused_at = excluded.paused_at`,
      )
      .run(ruleKey, pause ? 1 : 0, pause?.reason ?? null, pause?.by ?? null, pause?.at.getTime() ?? null);
  }

  /** Keeps `pass` in the rule's history, dropping the oldest beyond PASS_HISTORY. */
  recordPass(ruleKey: string, pass: RulePass): void {
    const s = pass.summary;
    this.db.exec('BEGIN');
    try {
      this.db
        .prepare(
          `INSERT INTO replay_rule_passes (id, rule_key, at, status, reason, held, replayed, moved, used_up, not_due, no_match, failed)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
          s?.failed ?? null,
        );
      this.db
        .prepare(
          `DELETE FROM replay_rule_passes WHERE rule_key = ? AND id NOT IN (
             SELECT id FROM replay_rule_passes WHERE rule_key = ? ORDER BY at DESC, rowid DESC LIMIT ?)`,
        )
        .run(ruleKey, ruleKey, PASS_HISTORY);
      this.db.exec('COMMIT');
    } catch (err) {
      if (this.db.isTransaction) this.db.exec('ROLLBACK');
      throw err;
    }
  }

  /** The rule's kept passes, newest first. */
  passes(ruleKey: string): RulePass[] {
    const rows = this.db
      .prepare('SELECT * FROM replay_rule_passes WHERE rule_key = ? ORDER BY at DESC, rowid DESC')
      .all(ruleKey) as unknown as PassRow[];
    return rows.map((r) => ({
      id: r.id,
      at: new Date(r.at).toISOString(),
      status: r.status,
      reason: r.reason,
      summary:
        r.held === null
          ? null
          : {
              held: r.held,
              replayed: r.replayed ?? 0,
              moved: r.moved ?? 0,
              usedUp: r.used_up ?? 0,
              notDue: r.not_due ?? 0,
              noMatch: r.no_match ?? 0,
              failed: r.failed ?? 0,
            },
    }));
  }

  /**
   * When a pass of the rule first saw each of `messageIds`: the stored time,
   * or `now` for an id not seen before (which is stored, dropping the oldest
   * beyond FIRST_SEEN_LIMIT).
   */
  firstSeen(ruleKey: string, messageIds: readonly string[], now: Date): Map<string, Date> {
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

  /** When a pass of the rule first saw `messageId`, without storing anything; null when none has. */
  firstSeenAt(ruleKey: string, messageId: string): Date | null {
    const row = this.db
      .prepare('SELECT first_seen_at FROM replay_rule_first_seen WHERE rule_key = ? AND message_id = ?')
      .get(ruleKey, messageId) as { first_seen_at: number } | undefined;
    return row ? new Date(Number(row.first_seen_at)) : null;
  }
}

interface StateRow {
  paused: number;
  paused_reason: string | null;
  paused_by: string | null;
  paused_at: number | null;
}

interface PassRow {
  id: string;
  at: number;
  status: RulePassStatus;
  reason: string | null;
  held: number | null;
  replayed: number | null;
  moved: number | null;
  used_up: number | null;
  not_due: number | null;
  no_match: number | null;
  failed: number | null;
}
