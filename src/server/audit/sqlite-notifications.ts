// The outcome of each notification in the audit store (migration v12), kept
// as long as the depth history (VOLVERAN_HISTORY_RETENTION_DAYS).
import type { DatabaseSync } from 'node:sqlite';
import type { NotificationDelivery } from '../../shared/alerts.js';
import type { NewNotificationDelivery, NotificationScope, NotificationStore } from './audit-store.js';

/** How many outcomes `recent` answers with unless told otherwise. */
const RECENT_LIMIT = 100;

function scopeClause({ profiles, tests }: NotificationScope): { where: string; params: string[] } {
  const names = 'only' in profiles ? profiles.only : profiles.except;
  const list = names.map(() => '?').join(', ');
  // NOT IN () is true of everything; a test notification's NULL profile matches neither form.
  const ofProfile = 'only' in profiles ? (names.length ? `profile IN (${list})` : '1 = 0') : names.length ? `profile NOT IN (${list})` : 'profile IS NOT NULL';
  return { where: `((test = 0 AND ${ofProfile}) OR (test = 1 AND ${tests ? '1 = 1' : '1 = 0'}))`, params: names };
}

export class SqliteNotificationStore implements NotificationStore {
  constructor(private readonly db: DatabaseSync) {}

  async record(d: NewNotificationDelivery): Promise<NotificationDelivery> {
    const { lastInsertRowid } = this.db
      .prepare(
        `INSERT INTO notifications (at, alert_id, destination, destination_type, status, test, rule, profile, vhost, queue,
           outcome, http_status, error, attempts, replay_rule)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        d.at.getTime(),
        d.alertId,
        d.destination,
        d.destinationType,
        d.status,
        d.test ? 1 : 0,
        d.rule,
        d.profile,
        d.vhost,
        d.queue,
        d.outcome,
        d.httpStatus,
        d.error,
        d.attempts,
        d.replayRule,
      );
    return { ...d, id: Number(lastInsertRowid), at: d.at.toISOString() };
  }

  /** The latest outcomes, newest first; `visible` narrows them in the query, so the limit counts only what is kept. */
  async recent(limit = RECENT_LIMIT, visible?: NotificationScope): Promise<NotificationDelivery[]> {
    const { where, params } = visible ? scopeClause(visible) : { where: '1 = 1', params: [] };
    const rows = this.db
      .prepare(`SELECT * FROM notifications WHERE ${where} ORDER BY at DESC, id DESC LIMIT ?`)
      .all(...params, limit) as unknown as Row[];
    return rows.map((row) => ({
      id: Number(row.id),
      at: new Date(row.at).toISOString(),
      alertId: row.alert_id,
      destination: row.destination,
      destinationType: row.destination_type as NotificationDelivery['destinationType'],
      status: row.status as NotificationDelivery['status'],
      test: row.test === 1,
      rule: row.rule,
      profile: row.profile,
      vhost: row.vhost,
      queue: row.queue,
      outcome: row.outcome as NotificationDelivery['outcome'],
      httpStatus: row.http_status,
      error: row.error,
      attempts: row.attempts,
      replayRule: row.replay_rule,
    }));
  }

  /** Removes the outcomes from before `cutoff`; returns how many. */
  async removeOlderThan(cutoff: Date): Promise<number> {
    return Number(this.db.prepare('DELETE FROM notifications WHERE at < ?').run(cutoff.getTime()).changes);
  }
}

interface Row {
  id: number;
  at: number;
  alert_id: string;
  destination: string;
  destination_type: string;
  status: string;
  test: number;
  rule: string;
  profile: string | null;
  vhost: string | null;
  queue: string | null;
  outcome: string;
  http_status: number | null;
  error: string | null;
  attempts: number;
  replay_rule: string | null;
}
