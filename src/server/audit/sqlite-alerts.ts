// Alerts in the audit store (migrations v14 and v15), so a restart neither forgets nor
// re-sends a firing one, with what arrival conditions remember of each queue.
// One evaluation's result replaces the profile's rows.
import type { DatabaseSync } from 'node:sqlite';
import type { AlertMemory } from '../alerts/evaluation.js';
import type { AlertStore, LeaseFence, OutgoingNotification, UnsentNotification } from './audit-store.js';
import type { MemoryLeaderLease } from './memory-leader-lease.js';
import { ALERT_COLUMNS, alertValues, toAlertMemory, type AlertRow, type ArrivalsRow } from './store-rows.js';

export class SqliteAlertStore implements AlertStore {
  private readonly outgoing = new Map<number, UnsentNotification>();
  private nextOutgoing = 1;

  constructor(
    private readonly db: DatabaseSync,
    private readonly lease: MemoryLeaderLease,
  ) {}

  /** What is remembered of the profile. */
  async load(profile: string): Promise<AlertMemory> {
    const alerts = this.db.prepare('SELECT * FROM alerts WHERE profile = ? ORDER BY rule, vhost, queue, replay_rule').all(profile) as unknown as AlertRow[];
    const arrivals = this.db.prepare('SELECT * FROM alert_queue_arrivals WHERE profile = ? ORDER BY vhost, queue').all(profile) as unknown as ArrivalsRow[];
    return toAlertMemory(alerts, arrivals);
  }

  /** Replaces what is remembered of the profile, in one commit. */
  async save(profile: string, memory: AlertMemory, outgoing: readonly OutgoingNotification[] = [], fence?: LeaseFence): Promise<number[]> {
    this.lease.check(fence);
    this.transaction(() => {
      this.db.prepare('DELETE FROM alerts WHERE profile = ?').run(profile);
      this.db.prepare('DELETE FROM alert_queue_arrivals WHERE profile = ?').run(profile);
      const alert = this.db.prepare(
        `INSERT INTO alerts (${ALERT_COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      for (const a of memory.alerts) alert.run(...alertValues(profile, a));
      const arrivals = this.db.prepare('INSERT INTO alert_queue_arrivals (profile, vhost, queue, unsettled, recent) VALUES (?, ?, ?, ?, ?)');
      for (const a of memory.arrivals) arrivals.run(profile, a.vhost, a.queue, a.unsettled, JSON.stringify(a.recent));
    });
    return outgoing.map((o) => {
      const id = this.nextOutgoing++;
      this.outgoing.set(id, { ...o, id, profile });
      return id;
    });
  }

  async unsent(): Promise<UnsentNotification[]> {
    return [...this.outgoing.values()];
  }

  async ended(id: number): Promise<void> {
    this.outgoing.delete(id);
  }

  /** Quietly forgets the Alerts of rules no longer in the file, and all of profiles no longer in it. */
  async keepOnly(rulesByProfile: ReadonlyMap<string, readonly string[]>, fence?: LeaseFence): Promise<void> {
    this.lease.check(fence);
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
