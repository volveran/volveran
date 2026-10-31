// Alerts on PostgreSQL. See sqlite-alerts.ts. Ordered bytewise, as SQLite orders text.
import type pg from 'pg';
import type { AlertMemory } from '../alerts/evaluation.js';
import type { AlertStore } from './audit-store.js';
import { transaction } from './postgres-connection.js';
import { ALERT_COLUMNS, alertValues, toAlertMemory, type AlertRow, type ArrivalsRow } from './store-rows.js';

export class PostgresAlertStore implements AlertStore {
  constructor(private readonly pool: pg.Pool) {}

  async load(profile: string): Promise<AlertMemory> {
    const [alerts, arrivals] = await Promise.all([
      this.pool.query<AlertRow>('SELECT * FROM alerts WHERE profile = $1 ORDER BY rule COLLATE "C", vhost COLLATE "C", queue COLLATE "C", replay_rule COLLATE "C"', [profile]),
      this.pool.query<ArrivalsRow>('SELECT * FROM alert_queue_arrivals WHERE profile = $1 ORDER BY vhost COLLATE "C", queue COLLATE "C"', [profile]),
    ]);
    return toAlertMemory(alerts.rows, arrivals.rows);
  }

  async save(profile: string, memory: AlertMemory): Promise<void> {
    await transaction(this.pool, async (client) => {
      await client.query('DELETE FROM alerts WHERE profile = $1', [profile]);
      await client.query('DELETE FROM alert_queue_arrivals WHERE profile = $1', [profile]);
      for (const a of memory.alerts) {
        await client.query(`INSERT INTO alerts (${ALERT_COLUMNS}) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`, [...alertValues(profile, a)]);
      }
      for (const a of memory.arrivals) {
        await client.query('INSERT INTO alert_queue_arrivals (profile, vhost, queue, unsettled, recent) VALUES ($1, $2, $3, $4, $5)', [profile, a.vhost, a.queue, a.unsettled, JSON.stringify(a.recent)]);
      }
    });
  }

  async keepOnly(rulesByProfile: ReadonlyMap<string, readonly string[]>): Promise<void> {
    await transaction(this.pool, async (client) => {
      const { rows } = await client.query<{ profile: string; rule: string }>('SELECT DISTINCT profile, rule FROM alerts');
      for (const { profile, rule } of rows) {
        if (!rulesByProfile.get(profile)?.includes(rule)) await client.query('DELETE FROM alerts WHERE profile = $1 AND rule = $2', [profile, rule]);
      }
      await client.query('DELETE FROM alert_queue_arrivals WHERE NOT (profile = ANY($1::text[]))', [[...rulesByProfile.keys()]]);
    });
  }
}
