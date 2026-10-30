// Pure values shared by the server and the web app (no Node or DOM APIs).
import { durationText, pauseReasonText } from './replay-rules.js';

export const ALERT_DESTINATION_TYPES = ['slack', 'teams', 'webhook'] as const;
export type AlertDestinationType = (typeof ALERT_DESTINATION_TYPES)[number];

export type NotificationStatus = 'firing' | 'resolved';
export type DeliveryOutcome = 'delivered' | 'failed';

/** The recorded outcome of one notification to one Alert Destination. Never holds the destination's URL. */
export interface NotificationDelivery {
  id: number;
  /** When the delivery ended. */
  at: string;
  alertId: string;
  destination: string;
  destinationType: AlertDestinationType;
  status: NotificationStatus;
  /** A test notification, not an Alert. */
  test: boolean;
  rule: string;
  profile: string | null;
  vhost: string | null;
  queue: string | null;
  /** The Replay Rule a `replayRulePaused` notification is about; null otherwise. */
  replayRule: string | null;
  outcome: DeliveryOutcome;
  /** The receiver's last HTTP status; null when it never answered. */
  httpStatus: number | null;
  /** Why it failed without an HTTP status: `timeout`, `server_stopping` or a network error code. */
  error: string | null;
  attempts: number;
}

/** One Alert, as the API shows it. `vhost` and `queue` are null for an Alert about no queue. */
export interface AlertView {
  alertId: string;
  profile: string;
  rule: string;
  vhost: string | null;
  queue: string | null;
  /** The Replay Rule a `replayRulePaused` Alert is about; null otherwise. */
  replayRule: string | null;
  /** Why the condition holds: a pause's reason, set-up warning codes or a sampling error code; null for queue conditions. */
  reason: string | null;
  status: 'pending' | 'firing';
  /** The kind of condition, such as `depthAbove`. */
  condition: string;
  value: number | null;
  threshold: number | null;
  /** When the condition began to hold. */
  since: string;
}

/** An Alert Destination as the browser may see it: never its URL or signing secret. */
export interface AlertDestinationView {
  name: string;
  type: AlertDestinationType;
}

/** What `GET /api/alerts` answers. */
export interface AlertsOverview {
  /** On the profiles the Operator has a Role on: firing first. */
  alerts: AlertView[];
  /** The latest outcomes the Operator may see, newest first. */
  notifications: NotificationDelivery[];
  destinations: AlertDestinationView[];
}

/** An Alert Rule's condition: its kind and whatever the kind takes. */
export interface AlertRuleCondition {
  kind: string;
  [key: string]: unknown;
}

/** An Alert Rule as the profiles file declares it. */
export interface AlertRuleView {
  name: string;
  destinations: AlertDestinationView[];
  when: AlertRuleCondition;
  forMs: number;
  /** null: never sent again. */
  repeatEveryMs: number | null;
}

export function alertPlaceText({ vhost, queue, replayRule }: { vhost: string | null; queue: string | null; replayRule?: string | null }): string {
  if (replayRule) return `Replay rule ${replayRule}`;
  if (queue !== null) return vhost === null ? queue : `${queue} (vhost ${vhost})`;
  return vhost === null ? 'The Broker Profile' : `Vhost ${vhost}`;
}

export function alertValueText({ condition, value: rawValue, threshold: rawThreshold }: { condition?: string; value: number | null; threshold: number | null }): string {
  // samplingFailing counts seconds.
  const shown = (n: number | null) => (n !== null && condition === 'samplingFailing' ? durationText(n * 1000) : n);
  const value = shown(rawValue);
  const threshold = shown(rawThreshold);
  if (value === null) return threshold === null ? '—' : `threshold ${threshold}`;
  return threshold === null ? String(value) : `${value} (threshold ${threshold})`;
}

/** An Alert Rule's condition in words; a kind with no words here is shown by name. */
export function ruleConditionText(when: AlertRuleCondition): string {
  const { kind, vhost, queue, queuePattern } = when;
  const place = typeof queue === 'string' ? queue : typeof queuePattern === 'string' ? `queues matching ${queuePattern}` : null;
  const on = place === null ? '' : ` on ${place}${typeof vhost === 'string' ? ` (vhost ${vhost})` : ''}`;
  switch (kind) {
    case 'depthAbove':
      return `Depth above ${String(when.threshold)}${on}`;
    case 'arrivalsAbove':
      return `More than ${String(when.count)} estimated arrivals within ${durationText(Number(when.withinMs))}${on}`;
    case 'anyArrival':
      return `Any Message arrives${on}`;
    case 'replayRulePaused':
      return typeof when.rule === 'string' ? `Replay rule ${when.rule} is paused` : 'Any Replay rule of the profile is paused';
    case 'setupWarning':
      return when.severity === 'loses_messages'
        ? 'A dead-letter queue has a set-up warning that loses Messages'
        : 'A dead-letter queue has a set-up warning that may lose Messages, or worse';
    case 'samplingFailing':
      return `Not sampled successfully for ${durationText(Number(when.forMs))}`;
    default:
      return kind;
  }
}

/** Why an Alert's condition holds, in words where it has some. */
export function alertReasonText({ condition, reason }: { condition: string; reason: string | null }): string {
  if (reason === null) return '';
  return condition === 'replayRulePaused' ? pauseReasonText(reason) : reason;
}

/** Whether a delivery got through and, when not, why. */
export function deliveryText({ outcome, httpStatus, error, attempts }: Pick<NotificationDelivery, 'outcome' | 'httpStatus' | 'error' | 'attempts'>): string {
  if (outcome === 'delivered') return attempts > 1 ? `Delivered on attempt ${attempts}` : 'Delivered';
  if (attempts === 0) return 'Failed: no attempt was made';
  const why = httpStatus !== null ? `HTTP ${httpStatus}` : error ?? 'unknown error';
  return `Failed after ${attempts} attempt${attempts === 1 ? '' : 's'}: ${why}`;
}
