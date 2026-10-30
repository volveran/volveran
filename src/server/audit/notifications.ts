// The outcome of each notification in the audit store (migration v12), kept
// as long as the depth history (VOLVERAN_HISTORY_RETENTION_DAYS).
import type { DatabaseSync } from 'node:sqlite';
import type { NotificationDelivery } from '../../shared/alerts.js';

export type NewNotificationDelivery = Omit<NotificationDelivery, 'id' | 'at'> & { at: Date };

/** How many outcomes `recent` answers with unless told otherwise. */
const RECENT_LIMIT = 100;

export class NotificationStore {
  constructor(private readonly db: DatabaseSync) {}

  record(d: NewNotificationDelivery): NotificationDelivery {
    const { lastInsertRowid } = this.db
      .prepare(
        `INSERT INTO notifications (at, alert_id, destination, destination_type, status, test, rule, profile, vhost, queue,
           outcome, http_status, error, attempts)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
      );
    return { ...d, id: Number(lastInsertRowid), at: d.at.toISOString() };
  }

  /** The latest outcomes, newest first. */
  recent(limit = RECENT_LIMIT): NotificationDelivery[] {
    const rows = this.db.prepare('SELECT * FROM notifications ORDER BY at DESC, id DESC LIMIT ?').all(limit) as unknown as Row[];
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
    }));
  }

  /** Removes the outcomes from before `cutoff`; returns how many. */
  removeOlderThan(cutoff: Date): number {
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
}
