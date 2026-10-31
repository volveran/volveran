// The outcome of each notification on PostgreSQL. See sqlite-notifications.ts.
import type pg from 'pg';
import { positions } from './audit-entry-sql.js';
import type { NewNotificationDelivery, NotificationScope, NotificationStore } from './audit-store.js';
import { numbered } from './postgres-connection.js';
import { notificationScope, RECENT_LIMIT, toDelivery, type NotificationRow } from './store-rows.js';
import type { NotificationDelivery } from '../../shared/alerts.js';

export class PostgresNotificationStore implements NotificationStore {
  constructor(private readonly pool: pg.Pool) {}

  async record(d: NewNotificationDelivery): Promise<NotificationDelivery> {
    const { rows } = await this.pool.query<{ id: number }>(
      `INSERT INTO notifications (at, alert_id, destination, destination_type, status, test, rule, profile, vhost, queue,
         outcome, http_status, error, attempts, replay_rule)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
       RETURNING id`,
      [d.at.getTime(), d.alertId, d.destination, d.destinationType, d.status, d.test ? 1 : 0, d.rule, d.profile, d.vhost, d.queue, d.outcome, d.httpStatus, d.error, d.attempts, d.replayRule],
    );
    return { ...d, id: rows[0]!.id, at: d.at.toISOString() };
  }

  async recent(limit = RECENT_LIMIT, visible?: NotificationScope): Promise<NotificationDelivery[]> {
    const next = positions(numbered);
    const { where, values } = visible ? notificationScope(visible, next) : { where: '1 = 1', values: [] };
    const { rows } = await this.pool.query<NotificationRow>(`SELECT * FROM notifications WHERE ${where} ORDER BY at DESC, id DESC LIMIT ${next()}`, [...values, limit]);
    return rows.map(toDelivery);
  }

  async removeOlderThan(cutoff: Date): Promise<number> {
    const { rowCount } = await this.pool.query('DELETE FROM notifications WHERE at < $1', [cutoff.getTime()]);
    return rowCount ?? 0;
  }
}
