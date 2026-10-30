// Pure: what a finished sampling run does to a Broker Profile's Alerts. It takes
// what is remembered (from the audit store) and answers what to remember next
// and which notifications to send; the caller stores and delivers them.
//
//   pending (condition true, `for` not yet elapsed; forgotten quietly if it goes false)
//   -> firing (notify; `repeatEvery` sends it again)
//   -> resolved (notify, once false at two Samples running: a full Sample apart).
//
// A resolved Alert is forgotten: the next firing is a new Alert with a new id. A
// failed run says nothing about any queue, so it changes no Alert (it may repeat
// one). So does a Sample whose arrivals are unknown, for an arrival condition.
//
// Arrivals here are the ones the Sample's depth has borne out, not the Sample's
// `estimatedArrivals`. Management depth lags Audit Entries, so depth 10 -> 10
// with 10 taken out estimates 10 arrivals that never happened, and the drop shows
// only in the next Sample. So a rise in depth counts at once, and a take-out is
// held for one Sample: a drop in that Sample settles it, and what no drop settles
// did hide arrivals, which count then, one Sample late. A consumer outside
// Volverán can settle a take-out too, and so hide arrivals, as it does anyway.
import { createHash } from 'node:crypto';
import { historyPath } from '../../shared/history-link.js';
import { matchesQueueFilter } from '../triage/queue-list.js';
import type { FinishedRun, LatestSample } from '../history/sampler.js';
import type { Notification } from './payloads.js';
import type { AlertCondition, AlertRule } from './rules.js';

/** One Alert: one Alert Rule on one queue, from when its condition held until it resolves. */
export interface AlertState {
  /** Stable from pending to resolved. */
  alertId: string;
  rule: string;
  vhost: string | null;
  queue: string | null;
  status: 'pending' | 'firing';
  condition: AlertCondition['kind'];
  /** The latest value of the condition. */
  value: number | null;
  threshold: number | null;
  /** When the condition began to hold (ms). */
  since: number;
  /** When a notification was last sent (ms); null while pending. */
  lastNotifiedAt: number | null;
  /** The first of the Samples running with the condition false (ms); null while it holds. */
  falseSince: number | null;
}

/** What arrival conditions remember of one queue. */
export interface QueueArrivals {
  vhost: string;
  queue: string;
  /** Messages taken out in the latest Sample whose drop in depth has not shown yet. */
  unsettled: number;
  /** Borne-out arrivals (at, in ms) within the longest window a rule looks at. */
  recent: Array<{ at: number; count: number }>;
}

/** What is kept between evaluations of one Broker Profile. */
export interface AlertMemory {
  alerts: AlertState[];
  arrivals: QueueArrivals[];
}

export const emptyAlertMemory = (): AlertMemory => ({ alerts: [], arrivals: [] });

export interface EvaluationInput {
  profile: string;
  rules: readonly AlertRule[];
  memory: AlertMemory;
  /** Its `run.at` is the time of the evaluation. */
  run: FinishedRun;
}

export interface AlertNotification {
  destinations: string[];
  notification: Notification;
}

export interface EvaluationResult {
  memory: AlertMemory;
  notifications: AlertNotification[];
}

/** Whether the condition holds of a queue at this Sample; null: cannot be told. */
interface Reading {
  holds: boolean | null;
  value: number | null;
  threshold: number | null;
}

export function evaluateAlerts({ profile, rules, memory, run: { run, samples } }: EvaluationInput): EvaluationResult {
  const now = run.at.getTime();
  const notifications: AlertNotification[] = [];
  const arrivals = run.ok ? reckonArrivals(rules, memory.arrivals, samples, now) : null;
  const previous = new Map(memory.alerts.map((a) => [alertKey(a.rule, a.vhost, a.queue), a]));
  const alerts: AlertState[] = [];

  const notify = (rule: AlertRule, alert: AlertState, status: Notification['status']) => {
    notifications.push({
      destinations: rule.destinations,
      notification: {
        alertId: alert.alertId,
        status,
        rule: rule.name,
        profile,
        vhost: alert.vhost,
        queue: alert.queue,
        condition: alert.condition,
        value: alert.value,
        threshold: alert.threshold,
        startedAt: new Date(alert.since).toISOString(),
        endedAt: status === 'resolved' ? new Date(now).toISOString() : null,
        path: alert.vhost !== null && alert.queue !== null ? historyPath({ profile, vhost: alert.vhost, queue: alert.queue }) : null,
      },
    });
  };

  const fireOrRepeat = (rule: AlertRule, alert: AlertState): AlertState => {
    if (alert.status === 'pending' && now - alert.since < rule.forMs) return alert;
    const due =
      alert.status === 'pending' ||
      (rule.repeatEveryMs !== null && alert.lastNotifiedAt !== null && now - alert.lastNotifiedAt >= rule.repeatEveryMs);
    if (!due) return alert;
    const next: AlertState = { ...alert, status: 'firing', lastNotifiedAt: now };
    notify(rule, next, 'firing');
    return next;
  };

  for (const rule of rules) {
    const ours = memory.alerts.filter((a) => a.rule === rule.name);
    if (arrivals === null) {
      // A failed run: no reading of any queue.
      for (const alert of ours) alerts.push(alert.status === 'firing' ? fireOrRepeat(rule, alert) : alert);
      continue;
    }

    const { vhost } = rule.when;
    const matching = samples.filter((s) => s.vhost === vhost && selects(rule.when, s.queue));
    for (const sample of matching) {
      const reading = read(rule.when, sample, arrivals, now);
      const key = alertKey(rule.name, vhost, sample.queue);
      const alert = previous.get(key);
      if (reading.holds === null) {
        if (alert) alerts.push(alert);
      } else if (reading.holds) {
        const base = alert
          ? { ...alert, value: reading.value, falseSince: null }
          : newAlert(profile, rule, sample, reading, now);
        alerts.push(fireOrRepeat(rule, base));
      } else if (alert) {
        const after = settleFalse(alert, reading.value, now, (ended) => notify(rule, ended, 'resolved'));
        if (after) alerts.push(after);
      }
    }
    // Alerts of queues gone from a good run: their condition cannot hold.
    const present = new Set(matching.map((s) => s.queue));
    for (const alert of ours) {
      if (alert.queue !== null && present.has(alert.queue) && alert.vhost === vhost) continue;
      const after = settleFalse(alert, alert.value, now, (ended) => notify(rule, ended, 'resolved'));
      if (after) alerts.push(after);
    }
  }

  return { memory: { alerts, arrivals: arrivals ?? memory.arrivals }, notifications };
}

/** A condition is false at this Sample: a pending Alert is forgotten, a firing one resolves at the second Sample running. */
function settleFalse(alert: AlertState, value: number | null, now: number, resolved: (alert: AlertState) => void): AlertState | null {
  if (alert.status === 'pending') return null;
  const next = { ...alert, value };
  if (alert.falseSince === null) return { ...next, falseSince: now };
  resolved(next);
  return null;
}

function newAlert(profile: string, rule: AlertRule, sample: LatestSample, reading: Reading, now: number): AlertState {
  return {
    alertId: createHash('sha256').update(JSON.stringify([profile, rule.name, sample.vhost, sample.queue, now])).digest('hex').slice(0, 32),
    rule: rule.name,
    vhost: sample.vhost,
    queue: sample.queue,
    status: 'pending',
    condition: rule.when.kind,
    value: reading.value,
    threshold: reading.threshold,
    since: now,
    lastNotifiedAt: null,
    falseSince: null,
  };
}

function selects(when: AlertCondition, queue: string): boolean {
  return when.queuePattern !== null ? matchesQueueFilter(queue, when.queuePattern) : when.queue === queue;
}

function read(when: AlertCondition, sample: LatestSample, arrivals: QueueArrivals[], now: number): Reading {
  if (when.kind === 'depthAbove') return { holds: sample.depth > when.threshold, value: sample.depth, threshold: when.threshold };
  const threshold = when.kind === 'arrivalsAbove' ? when.count : null;
  if (sample.previousDepth === null) return { holds: null, value: null, threshold };
  const recent = arrivals.find((a) => a.vhost === sample.vhost && a.queue === sample.queue)?.recent ?? [];
  if (when.kind === 'anyArrival') {
    const value = recent.find((r) => r.at === now)?.count ?? 0;
    return { holds: value > 0, value, threshold };
  }
  const value = recent.filter((r) => r.at > now - when.withinMs).reduce((sum, r) => sum + r.count, 0);
  return { holds: value > when.count, value, threshold };
}

/** Carries each queue an arrival condition watches forward by its Sample; other queues are not remembered. */
function reckonArrivals(rules: readonly AlertRule[], previous: QueueArrivals[], samples: LatestSample[], now: number): QueueArrivals[] {
  const watching = rules.flatMap((r) => (r.when.kind === 'depthAbove' ? [] : [r.when]));
  const keepMs = Math.max(0, ...watching.map((w) => (w.kind === 'arrivalsAbove' ? w.withinMs : 0)));
  const next: QueueArrivals[] = [];
  for (const sample of samples) {
    if (!watching.some((w) => w.vhost === sample.vhost && selects(w, sample.queue))) continue;
    const before = previous.find((a) => a.vhost === sample.vhost && a.queue === sample.queue);
    const carried = { unsettled: before?.unsettled ?? 0, recent: before?.recent ?? [] };
    const { unsettled, arrived } = reckon(carried.unsettled, sample);
    next.push({
      vhost: sample.vhost,
      queue: sample.queue,
      unsettled,
      recent: [...carried.recent.filter((r) => r.at > now - keepMs), ...(arrived > 0 ? [{ at: now, count: arrived }] : [])],
    });
  }
  return next;
}

/** One Sample: its drop in depth settles the take-outs held from before, then its own. */
function reckon(held: number, { depth, previousDepth, takenOut }: LatestSample): { unsettled: number; arrived: number } {
  if (previousDepth === null) return { unsettled: held, arrived: 0 };
  const change = depth - previousDepth;
  const drop = Math.max(0, -change);
  return {
    unsettled: Math.max(0, takenOut - Math.max(0, drop - held)),
    arrived: Math.max(0, change) + Math.max(0, held - drop),
  };
}

function alertKey(rule: string, vhost: string | null, queue: string | null): string {
  return JSON.stringify([rule, vhost, queue]);
}
