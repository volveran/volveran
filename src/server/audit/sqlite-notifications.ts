// The outcome of each notification in the audit store (migration v12), kept
// as long as the depth history (VOLVERAN_HISTORY_RETENTION_DAYS).
import type { DatabaseSync } from 'node:sqlite';
import type { NotificationDelivery } from '../../shared/alerts.js';
import type { NewNotificationDelivery, NotificationScope, NotificationStore } from './audit-store.js';
import { notificationScope, RECENT_LIMIT, toDelivery, type NotificationRow } from './store-rows.js';

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
    const { where, values } = visible ? notificationScope(visible, () => '?') : { where: '1 = 1', values: [] };
    const rows = this.db
      .prepare(`SELECT * FROM notifications WHERE ${where} ORDER BY at DESC, id DESC LIMIT ?`)
      .all(...values, limit) as unknown as NotificationRow[];
    return rows.map(toDelivery);
  }

  /** Removes the outcomes from before `cutoff`; returns how many. */
  async removeOlderThan(cutoff: Date): Promise<number> {
    return Number(this.db.prepare('DELETE FROM notifications WHERE at < ?').run(cutoff.getTime()).changes);
  }
}
