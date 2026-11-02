// Alerts on PostgreSQL. See sqlite-alerts.ts. Ordered bytewise, as SQLite orders text.
import type pg from 'pg';
import type { AlertMemory } from '../alerts/evaluation.js';
import type { Notification } from '../alerts/payloads.js';
import type { AlertStore, LeaseFence, OutgoingNotification, UnsentNotification } from './audit-store.js';
import { transaction } from './postgres-connection.js';
import { fenced } from './postgres-leader-lease.js';
import { ALERT_COLUMNS, alertValues, toAlertMemory, type AlertRow, type ArrivalsRow } from './store-rows.js';

export class PostgresAlertStore implements AlertStore {
  constructor(private readonly pool: pg.Pool) {}

  async load(profile: string): Promise<AlertMemory> {
    return transaction(this.pool, async (client) => {
      const alerts = await client.query<AlertRow>('SELECT * FROM alerts WHERE profile = $1 ORDER BY rule COLLATE "C", vhost COLLATE "C", queue COLLATE "C", replay_rule COLLATE "C"', [profile]);
      const arrivals = await client.query<ArrivalsRow>('SELECT * FROM alert_queue_arrivals WHERE profile = $1 ORDER BY vhost COLLATE "C", queue COLLATE "C"', [profile]);
      return toAlertMemory(alerts.rows, arrivals.rows);
    });
  }

  async save(profile: string, memory: AlertMemory, outgoing: readonly OutgoingNotification[] = [], fence?: LeaseFence): Promise<number[]> {
    return fenced(this.pool, fence, async (client) => {
      await client.query('DELETE FROM alerts WHERE profile = $1', [profile]);
      await client.query('DELETE FROM alert_queue_arrivals WHERE profile = $1', [profile]);
      for (const a of memory.alerts) {
        await client.query(`INSERT INTO alerts (${ALERT_COLUMNS}) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`, [...alertValues(profile, a)]);
      }
      for (const a of memory.arrivals) {
        await client.query('INSERT INTO alert_queue_arrivals (profile, vhost, queue, unsettled, recent) VALUES ($1, $2, $3, $4, $5)', [profile, a.vhost, a.queue, a.unsettled, JSON.stringify(a.recent)]);
      }
      const ids: number[] = [];
      for (const o of outgoing) {
        const { rows } = await client.query<{ id: string | number }>(
          'INSERT INTO alert_unsent_notifications (profile, destination, notification) VALUES ($1, $2, $3) RETURNING id',
          [profile, o.destination, JSON.stringify(o.notification)],
        );
        ids.push(Number(rows[0]!.id));
      }
      return ids;
    });
  }

  async unsent(): Promise<UnsentNotification[]> {
    const { rows } = await this.pool.query<{ id: string | number; profile: string; destination: string; notification: string }>(
      'SELECT id, profile, destination, notification FROM alert_unsent_notifications ORDER BY id',
    );
    return rows.map((r) => ({ id: Number(r.id), profile: r.profile, destination: r.destination, notification: JSON.parse(r.notification) as Notification }));
  }

  async ended(id: number): Promise<void> {
    await this.pool.query('DELETE FROM alert_unsent_notifications WHERE id = $1', [id]);
  }

  async keepOnly(rulesByProfile: ReadonlyMap<string, readonly string[]>, fence?: LeaseFence): Promise<void> {
    await fenced(this.pool, fence, async (client) => {
      const { rows } = await client.query<{ profile: string; rule: string }>('SELECT DISTINCT profile, rule FROM alerts');
      for (const { profile, rule } of rows) {
        if (!rulesByProfile.get(profile)?.includes(rule)) await client.query('DELETE FROM alerts WHERE profile = $1 AND rule = $2', [profile, rule]);
      }
      await client.query('DELETE FROM alert_queue_arrivals WHERE NOT (profile = ANY($1::text[]))', [[...rulesByProfile.keys()]]);
    });
  }
}
