// Pure: what a finished sampling run, or a Replay Rule's pause or resume, does to
// a Broker Profile's Alerts. It takes what is remembered (from the audit store)
// and answers what to remember next and which notifications to send; the caller
// stores and delivers them.
//
//   pending (condition true, `for` not yet elapsed; forgotten quietly if it goes false)
//   -> firing (notify; `repeatEvery` sends it again)
//   -> resolved (notify, once false at two Samples running: a full Sample apart).
//
// A resolved Alert is forgotten: the next firing is a new Alert with a new id. A
// failed run says nothing about any queue, so it changes no Alert (it may repeat
// one). So does a Sample whose arrivals are unknown, for an arrival condition.
//
// Conditions on Volverán itself:
// - replayRulePaused holds while a Replay Rule is paused, each its own Alert, from
//   the pause; it resolves at the resume, with no second Sample to wait for. A
//   Replay Rule deployed with `startPaused` was never paused: the caller leaves it out.
// - setupWarning is about each queue of a Sample, as queue conditions are.
// - samplingFailing holds from the profile's last good run (or, if it has never
//   had one, its first failed run), and resolves at the next good run.
// An evaluation with no run (a pause or resume) changes only replayRulePaused Alerts.
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
import type { SetupWarningSeverity } from '../../shared/queues.js';
import { PAUSE_REASON_LIMIT } from '../../shared/replay-rules.js';
import type { AlertCondition, AlertRule, QueueCondition } from './rules.js';

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
  /** The Replay Rule of a replayRulePaused Alert; null otherwise. */
  replayRule: string | null;
  /** Why the condition holds: a pause's reason, set-up warning codes or a sampling error code; null for queue conditions. */
  reason: string | null;
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
  /** The time of the evaluation. */
  at: Date;
  /** The sampling run that finished; null when a Replay Rule was paused or resumed. */
  run: FinishedRun | null;
  /** The Replay Rules of the profile that were paused, now. */
  pausedReplayRules: readonly PausedReplayRule[];
  /** When the profile last ran well; null when it never has. */
  lastSuccessAt: Date | null;
}

export interface PausedReplayRule {
  name: string;
  reason: string | null;
  /** When it was paused (ms). */
  pausedAt: number;
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
  reason?: string;
}

export function evaluateAlerts({ profile, rules, memory, at, run, pausedReplayRules, lastSuccessAt }: EvaluationInput): EvaluationResult {
  const now = at.getTime();
  const notifications: AlertNotification[] = [];
  const samples = run?.run.ok ? run.samples : null;
  const arrivals = samples ? reckonArrivals(rules, memory.arrivals, samples, now) : null;
  const previous = new Map(memory.alerts.map((a) => [alertKey(a), a]));
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
        // An Alert about no queue has no history to show: the link opens Volverán.
        path: alert.vhost !== null && alert.queue !== null ? historyPath({ profile, vhost: alert.vhost, queue: alert.queue }) : '/',
        replayRule: alert.replayRule,
        reason: alert.reason,
      },
    });
  };

  const fireOrRepeat = (rule: AlertRule, alert: AlertState): AlertState => {
    const forMs = rule.when.kind === 'samplingFailing' ? rule.when.forMs : rule.forMs;
    if (alert.status === 'pending' && now - alert.since < forMs) return alert;
    const due =
      alert.status === 'pending' ||
      (rule.repeatEveryMs !== null && alert.lastNotifiedAt !== null && now - alert.lastNotifiedAt >= rule.repeatEveryMs);
    if (!due) return alert;
    const next: AlertState = { ...alert, status: 'firing', lastNotifiedAt: now };
    notify(rule, next, 'firing');
    return next;
  };

  /** A condition that goes false resolves at once: a pending Alert is forgotten, a firing one sends its resolved. */
  const endAtOnce = (rule: AlertRule, alert: AlertState, value: number | null) => {
    if (alert.status === 'firing') notify(rule, { ...alert, value }, 'resolved');
  };

  for (const rule of rules) {
    const { when } = rule;
    const ours = memory.alerts.filter((a) => a.rule === rule.name);

    if (when.kind === 'replayRulePaused') {
      const paused = pausedReplayRules.filter((r) => when.rule === null || r.name === when.rule);
      for (const replayRule of paused) {
        const reason = replayRule.reason?.slice(0, PAUSE_REASON_LIMIT) ?? null;
        const alert = ours.find((a) => a.replayRule === replayRule.name);
        const since = Math.min(replayRule.pausedAt, now);
        const base = alert ? { ...alert, reason } : newAlert(profile, rule, { replayRule: replayRule.name, reason }, { holds: true, value: null, threshold: null }, since);
        alerts.push(fireOrRepeat(rule, base));
      }
      for (const alert of ours) {
        if (!paused.some((r) => r.name === alert.replayRule)) endAtOnce(rule, alert, null);
      }
      continue;
    }

    // A pause or resume says nothing of samples or sampling.
    if (run === null) {
      alerts.push(...ours);
      continue;
    }

    if (when.kind === 'samplingFailing') {
      if (run.run.ok) {
        for (const alert of ours) endAtOnce(rule, alert, 0);
        continue;
      }
      const reason = run.run.errorCode;
      const alert = ours[0];
      const since = alert?.since ?? lastSuccessAt?.getTime() ?? now;
      const reading = { holds: true, value: Math.round((now - since) / 1000), threshold: Math.round(when.forMs / 1000) };
      const base = alert ? { ...alert, value: reading.value, reason } : newAlert(profile, rule, { reason }, reading, since);
      alerts.push(fireOrRepeat(rule, base));
      continue;
    }

    if (samples === null || arrivals === null) {
      // A failed run: no reading of any queue.
      for (const alert of ours) alerts.push(alert.status === 'firing' ? fireOrRepeat(rule, alert) : alert);
      continue;
    }

    const matching = when.kind === 'setupWarning' ? samples : samples.filter((s) => s.vhost === when.vhost && selects(when, s.queue));
    for (const sample of matching) {
      const reading = when.kind === 'setupWarning' ? readWarnings(when.severity, sample) : read(when, sample, arrivals, now);
      const alert = previous.get(alertKey({ rule: rule.name, vhost: sample.vhost, queue: sample.queue, replayRule: null }));
      if (reading.holds === null) {
        if (alert) alerts.push(alert);
      } else if (reading.holds) {
        const reason = reading.reason ?? null;
        const base = alert
          ? { ...alert, value: reading.value, reason, falseSince: null }
          : newAlert(profile, rule, { vhost: sample.vhost, queue: sample.queue, reason }, reading, now);
        alerts.push(fireOrRepeat(rule, base));
      } else if (alert) {
        const after = settleFalse(alert, reading.value, now, (ended) => notify(rule, ended, 'resolved'));
        if (after) alerts.push(after);
      }
    }
    // Alerts of queues gone from a good run: their condition cannot hold.
    const present = new Set(matching.map((s) => JSON.stringify([s.vhost, s.queue])));
    for (const alert of ours) {
      if (alert.queue !== null && present.has(JSON.stringify([alert.vhost, alert.queue]))) continue;
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

/** What an Alert is about, besides its rule; what is left out does not apply. */
interface AlertSubject {
  vhost?: string;
  queue?: string;
  replayRule?: string;
  reason?: string | null;
}

function newAlert(profile: string, rule: AlertRule, subject: AlertSubject, reading: Reading, since: number): AlertState {
  const { vhost = null, queue = null, replayRule = null, reason = null } = subject;
  return {
    alertId: createHash('sha256').update(JSON.stringify([profile, rule.name, vhost, queue, replayRule, since])).digest('hex').slice(0, 32),
    rule: rule.name,
    vhost,
    queue,
    status: 'pending',
    condition: rule.when.kind,
    value: reading.value,
    threshold: reading.threshold,
    since,
    lastNotifiedAt: null,
    falseSince: null,
    replayRule,
    reason,
  };
}

function selects(when: QueueCondition, queue: string): boolean {
  return when.queuePattern !== null ? matchesQueueFilter(queue, when.queuePattern) : when.queue === queue;
}

/** The queue's set-up warnings at least as bad as `severity`; `loses_messages` is the worst. */
function readWarnings(severity: SetupWarningSeverity, sample: LatestSample): Reading {
  const warnings = sample.setupWarnings.filter((w) => severity === 'may_lose_messages' || w.severity === 'loses_messages');
  return { holds: warnings.length > 0, value: warnings.length, threshold: null, reason: warnings.map((w) => w.code).join(', ') };
}

function read(when: QueueCondition, sample: LatestSample, arrivals: QueueArrivals[], now: number): Reading {
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
  const watching = rules.flatMap((r) => (r.when.kind === 'arrivalsAbove' || r.when.kind === 'anyArrival' ? [r.when] : []));
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

function alertKey({ rule, vhost, queue, replayRule }: Pick<AlertState, 'rule' | 'vhost' | 'queue' | 'replayRule'>): string {
  return JSON.stringify([rule, vhost, queue, replayRule]);
}
