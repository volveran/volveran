// Replay Rule state on PostgreSQL. See sqlite-rule-state.ts for what is kept and why.
import type pg from 'pg';
import { insertEntry } from './audit-entry-sql.js';
import { FIRST_SEEN_LIMIT, PASS_HISTORY, type RulePauseEntry, type RuleStateStore } from './audit-store.js';
import { numbered, transaction } from './postgres-connection.js';
import { toPass, toRuleState, type PassRow, type RuleStateRow } from './store-rows.js';
import type { RulePass, RuleState } from '../../shared/replay-rules.js';

const READ_STATE = 'SELECT * FROM replay_rule_state WHERE rule_key = $1';

export class PostgresRuleStateStore implements RuleStateStore {
  constructor(private readonly pool: pg.Pool) {}

  async ensure(ruleKey: string, startPaused: boolean): Promise<RuleState> {
    return transaction(this.pool, async (client) => {
      await client.query('INSERT INTO replay_rule_state (rule_key, paused) VALUES ($1, $2) ON CONFLICT (rule_key) DO NOTHING', [ruleKey, startPaused ? 1 : 0]);
      const { rows } = await client.query<RuleStateRow>(READ_STATE, [ruleKey]);
      return toRuleState(rows[0]!);
    });
  }

  async state(ruleKey: string): Promise<RuleState | null> {
    const { rows } = await this.pool.query<RuleStateRow>(READ_STATE, [ruleKey]);
    return rows[0] ? toRuleState(rows[0]) : null;
  }

  async pause(ruleKey: string, pause: { reason: string; by: string; at: Date }, entry: RulePauseEntry): Promise<void> {
    await transaction(this.pool, async (client) => {
      await setPaused(client, ruleKey, pause);
      await writeDoneEntry(client, entry);
    });
  }

  async resume(ruleKey: string, entry: RulePauseEntry): Promise<void> {
    await transaction(this.pool, async (client) => {
      await setPaused(client, ruleKey, null);
      await client.query('DELETE FROM replay_rule_died_again WHERE rule_key = $1', [ruleKey]);
      await writeDoneEntry(client, entry);
    });
  }

  async recordPass(ruleKey: string, pass: RulePass): Promise<void> {
    const s = pass.summary;
    await transaction(this.pool, async (client) => {
      await client.query(
        `INSERT INTO replay_rule_passes (id, rule_key, at, status, reason, held, replayed, moved, used_up, not_due, no_match, cannot_replay, failed)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
        [
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
        ],
      );
      await client.query(
        `DELETE FROM replay_rule_passes WHERE seq IN (
           SELECT seq FROM replay_rule_passes WHERE rule_key = $1 ORDER BY at DESC, seq DESC OFFSET $2)`,
        [ruleKey, PASS_HISTORY],
      );
    });
  }

  async passes(ruleKey: string): Promise<RulePass[]> {
    const { rows } = await this.pool.query<PassRow>('SELECT * FROM replay_rule_passes WHERE rule_key = $1 ORDER BY at DESC, seq DESC', [ruleKey]);
    return rows.map(toPass);
  }

  async firstSeen(ruleKey: string, messageIds: readonly string[], now: Date): Promise<Map<string, Date>> {
    if (messageIds.length === 0) return new Map();
    const ids = [...new Set(messageIds)];
    return transaction(this.pool, async (client) => {
      await client.query(
        'INSERT INTO replay_rule_first_seen (rule_key, message_id, first_seen_at) SELECT $1::text, id, $2::bigint FROM unnest($3::text[]) AS id ON CONFLICT DO NOTHING',
        [ruleKey, now.getTime(), ids],
      );
      const seen = await readFirstSeen(client, ruleKey, ids);
      await client.query(
        `DELETE FROM replay_rule_first_seen WHERE rule_key = $1 AND message_id IN (
           SELECT message_id FROM replay_rule_first_seen WHERE rule_key = $1 ORDER BY first_seen_at DESC OFFSET $2)`,
        [ruleKey, FIRST_SEEN_LIMIT],
      );
      return seen;
    });
  }

  async countDiedAgain(ruleKey: string, rule: { profile: string; name: string }, auditEntryIds: readonly number[], now: Date, since: Date): Promise<number> {
    return transaction(this.pool, async (client) => {
      await client.query(
        `INSERT INTO replay_rule_died_again (rule_key, audit_entry_id, seen_at)
         SELECT $1::text, id, $2::bigint FROM audit_entries WHERE id = ANY($3::bigint[]) AND profile = $4 AND rule = $5
         ON CONFLICT DO NOTHING`,
        [ruleKey, now.getTime(), [...auditEntryIds], rule.profile, rule.name],
      );
      await client.query('DELETE FROM replay_rule_died_again WHERE rule_key = $1 AND seen_at < $2', [ruleKey, since.getTime()]);
      const { rows } = await client.query<{ n: number }>('SELECT COUNT(*) AS n FROM replay_rule_died_again WHERE rule_key = $1', [ruleKey]);
      return rows[0]!.n;
    });
  }

  async firstSeenAt(ruleKey: string, messageIds: readonly string[]): Promise<Map<string, Date>> {
    return readFirstSeen(this.pool, ruleKey, messageIds);
  }
}

async function setPaused(client: pg.PoolClient, ruleKey: string, pause: { reason: string; by: string; at: Date } | null): Promise<void> {
  await client.query(
    `INSERT INTO replay_rule_state (rule_key, paused, paused_reason, paused_by, paused_at) VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (rule_key) DO UPDATE SET paused = excluded.paused, paused_reason = excluded.paused_reason,
       paused_by = excluded.paused_by, paused_at = excluded.paused_at`,
    [ruleKey, pause ? 1 : 0, pause?.reason ?? null, pause?.by ?? null, pause?.at.getTime() ?? null],
  );
}

async function writeDoneEntry(client: pg.PoolClient, entry: RulePauseEntry): Promise<void> {
  const { sql, values } = insertEntry(entry, numbered);
  const { rows } = await client.query<{ id: number }>(`${sql} RETURNING id`, values);
  await client.query(`UPDATE audit_entries SET outcome = 'done' WHERE id = $1`, [rows[0]!.id]);
}

async function readFirstSeen(on: pg.Pool | pg.PoolClient, ruleKey: string, messageIds: readonly string[]): Promise<Map<string, Date>> {
  const { rows } = await on.query<{ message_id: string; first_seen_at: number }>(
    'SELECT message_id, first_seen_at FROM replay_rule_first_seen WHERE rule_key = $1 AND message_id = ANY($2::text[])',
    [ruleKey, [...messageIds]],
  );
  return new Map(rows.map((row) => [row.message_id, new Date(row.first_seen_at)]));
}
