// What both stores share about Replay Rule state, depth history, notifications and
// Alerts: how a row reads back, and the conditions that must mean the same on each.
// As in audit-entry-sql.ts, the stores differ only in how a statement names its
// parameters and in how they run it.
import type { Placeholder } from './audit-entry-sql.js';
import type { NotificationScope, StoredSamplingRun, StoredSample, TakeOut } from './audit-store.js';
import type { AlertMemory, AlertState } from '../alerts/evaluation.js';
import type { NotificationDelivery } from '../../shared/alerts.js';
import type { RulePass, RulePassStatus, RuleState } from '../../shared/replay-rules.js';

export interface RuleStateRow {
  paused: number;
  paused_reason: string | null;
  paused_by: string | null;
  paused_at: number | null;
}

export function toRuleState(row: RuleStateRow): RuleState {
  return {
    paused: row.paused === 1,
    pausedReason: row.paused_reason,
    pausedBy: row.paused_by,
    pausedAt: row.paused_at === null ? null : new Date(row.paused_at).toISOString(),
  };
}

export interface PassRow {
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
  cannot_replay: number | null;
  failed: number | null;
}

export function toPass(r: PassRow): RulePass {
  return {
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
            cannotReplay: r.cannot_replay ?? 0,
            failed: r.failed ?? 0,
          },
  };
}

export interface SampleRow {
  at: number;
  depth: number;
  estimated_arrivals: number | null;
}

export function toSample(row: SampleRow): StoredSample {
  return { at: row.at, depth: row.depth, estimatedArrivals: row.estimated_arrivals };
}

export interface RunRow {
  at: number;
  ok: number;
  error_code: string | null;
  interval_ms: number | null;
}

export function toRun(row: RunRow): StoredSamplingRun {
  return { at: row.at, ok: row.ok === 1, errorCode: row.error_code, intervalMs: row.interval_ms };
}

/** Taking a Message out is one of these, carried out. A Keep or a failed step leaves it in the queue. */
export const TAKEN_OUT = `action IN ('discard', 'replay', 'move') AND outcome = 'done'`;

export interface TakeOutRow {
  checkout_id: string;
  action: 'discard' | 'replay' | 'move';
  n: number;
  at: number;
  operator: string;
  rule: string | null;
}

/** Each Checkout's take-outs, by Decision, from a row per Checkout and action; oldest first. */
export function toTakeOuts(rows: readonly TakeOutRow[]): TakeOut[] {
  const byCheckout = new Map<string, TakeOut>();
  for (const row of rows) {
    const mark = byCheckout.get(row.checkout_id) ?? {
      checkoutId: row.checkout_id,
      at: row.at,
      operator: row.operator,
      rule: row.rule,
      counts: { discard: 0, replay: 0, move: 0 },
    };
    mark.at = Math.max(mark.at, row.at);
    mark.counts[row.action] = Number(row.n);
    byCheckout.set(row.checkout_id, mark);
  }
  return [...byCheckout.values()].sort((a, b) => a.at - b.at);
}

export interface NotificationRow {
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

export function toDelivery(row: NotificationRow): NotificationDelivery {
  return {
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
  };
}

/** The condition keeping what `scope` shows, and its values; `next` names each parameter in turn. */
export function notificationScope({ profiles, tests }: NotificationScope, next: () => string): { where: string; values: string[] } {
  const names = 'only' in profiles ? profiles.only : profiles.except;
  const list = names.map(() => next()).join(', ');
  // NOT IN () is true of everything; a test notification's NULL profile matches neither form.
  const ofProfile = 'only' in profiles ? (names.length ? `profile IN (${list})` : '1 = 0') : names.length ? `profile NOT IN (${list})` : 'profile IS NOT NULL';
  return { where: `((test = 0 AND ${ofProfile}) OR (test = 1 AND ${tests ? '1 = 1' : '1 = 0'}))`, values: names };
}

/** Stands for no vhost, queue or Replay Rule in the Alert tables' keys. */
export const NONE = '';

export interface AlertRow {
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
  replay_rule: string;
  reason: string | null;
}

export interface ArrivalsRow {
  vhost: string;
  queue: string;
  unsettled: number;
  recent: string;
}

export function toAlertMemory(alerts: readonly AlertRow[], arrivals: readonly ArrivalsRow[]): AlertMemory {
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
      replayRule: r.replay_rule === NONE ? null : r.replay_rule,
      reason: r.reason,
    })),
    arrivals: arrivals.map((r) => ({ vhost: r.vhost, queue: r.queue, unsettled: r.unsettled, recent: JSON.parse(r.recent) })),
  };
}

/** The columns of a saved Alert, in the order of `alertValues`. */
export const ALERT_COLUMNS = 'profile, rule, vhost, queue, replay_rule, alert_id, status, condition, value, threshold, since, last_notified_at, false_since, reason';

export const alertValues = (profile: string, a: AlertState) =>
  [profile, a.rule, a.vhost ?? NONE, a.queue ?? NONE, a.replayRule ?? NONE, a.alertId, a.status, a.condition, a.value, a.threshold, a.since, a.lastNotifiedAt, a.falseSince, a.reason] as const;
