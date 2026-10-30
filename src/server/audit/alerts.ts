// Alerts in the audit store (migration v14), so a restart neither forgets nor
// re-sends a firing one, with what arrival conditions remember of each queue.
// One evaluation's result replaces the profile's rows.
import type { DatabaseSync } from 'node:sqlite';
import type { AlertMemory, AlertState } from '../alerts/evaluation.js';

/** Stands for no vhost or queue in the tables' keys. */
const NONE = '';

export class AlertStore {
  constructor(private readonly db: DatabaseSync) {}

  /** What is remembered of the profile. */
  load(profile: string): AlertMemory {
    const alerts = this.db.prepare('SELECT * FROM alerts WHERE profile = ? ORDER BY rule, vhost, queue').all(profile) as unknown as AlertRow[];
    const arrivals = this.db.prepare('SELECT * FROM alert_queue_arrivals WHERE profile = ? ORDER BY vhost, queue').all(profile) as unknown as ArrivalsRow[];
    return {
      alerts: alerts.map((r) => ({
        alertId: r.alert_id,
        rule: r.rule,
        vhost: r.vhost === NONE ? null : r.vhost,
        queue: r.queue === NONE ? null : r.queue,
        status: r.status as AlertState['status'],
        condition: r.condition as AlertState['condition'],
        value: r.value,
        threshold: r.threshold,
        since: r.since,
        lastNotifiedAt: r.last_notified_at,
        falseSince: r.false_since,
      })),
      arrivals: arrivals.map((r) => ({ vhost: r.vhost, queue: r.queue, unsettled: r.unsettled, recent: JSON.parse(r.recent) })),
    };
  }

  /** Replaces what is remembered of the profile, in one commit. */
  save(profile: string, memory: AlertMemory): void {
    this.transaction(() => {
      this.db.prepare('DELETE FROM alerts WHERE profile = ?').run(profile);
      this.db.prepare('DELETE FROM alert_queue_arrivals WHERE profile = ?').run(profile);
      const alert = this.db.prepare(
        `INSERT INTO alerts (profile, rule, vhost, queue, alert_id, status, condition, value, threshold, since, last_notified_at, false_since)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      for (const a of memory.alerts) {
        alert.run(profile, a.rule, a.vhost ?? NONE, a.queue ?? NONE, a.alertId, a.status, a.condition, a.value, a.threshold, a.since, a.lastNotifiedAt, a.falseSince);
      }
      const arrivals = this.db.prepare('INSERT INTO alert_queue_arrivals (profile, vhost, queue, unsettled, recent) VALUES (?, ?, ?, ?, ?)');
      for (const a of memory.arrivals) arrivals.run(profile, a.vhost, a.queue, a.unsettled, JSON.stringify(a.recent));
    });
  }

  /** Quietly forgets the Alerts of rules no longer in the file, and all of profiles no longer in it. */
  keepOnly(rulesByProfile: ReadonlyMap<string, readonly string[]>): void {
    this.transaction(() => {
      const rows = this.db.prepare('SELECT DISTINCT profile, rule FROM alerts').all() as unknown as Array<{ profile: string; rule: string }>;
      const remove = this.db.prepare('DELETE FROM alerts WHERE profile = ? AND rule = ?');
      for (const { profile, rule } of rows) {
        if (!rulesByProfile.get(profile)?.includes(rule)) remove.run(profile, rule);
      }
      const profiles = this.db.prepare('SELECT DISTINCT profile FROM alert_queue_arrivals').all() as unknown as Array<{ profile: string }>;
      const forget = this.db.prepare('DELETE FROM alert_queue_arrivals WHERE profile = ?');
      for (const { profile } of profiles) if (!rulesByProfile.has(profile)) forget.run(profile);
    });
  }

  private transaction(work: () => void): void {
    this.db.exec('BEGIN');
    try {
      work();
      this.db.exec('COMMIT');
    } catch (err) {
      if (this.db.isTransaction) this.db.exec('ROLLBACK');
      throw err;
    }
  }
}

interface AlertRow {
  rule: string;
  vhost: string;
  queue: string;
  alert_id: string;
  status: string;
  condition: string;
  value: number | null;
  threshold: number | null;
  since: number;
  last_notified_at: number | null;
  false_since: number | null;
}

interface ArrivalsRow {
  vhost: string;
  queue: string;
  unsettled: number;
  recent: string;
}
