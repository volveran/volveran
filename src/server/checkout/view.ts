// What the API returns for a Checkout: its held Messages, each with its
// Decision, and the summary of the Decisions shown before Apply.
import { summaryText, type Decision, type DecisionSummaryLine } from '../../shared/decisions.js';
import { applyConfirmationFor, type ApplyConfirmation } from '../triage/apply-confirmation.js';
import { summarizeDecisions } from '../triage/decisions.js';
import { messageSummary, type MessageSummary, type QueueInfo } from '../triage/message-view.js';
import { replayOrigin } from '../triage/replay-origin.js';
import type { CheckoutLimits, LimitedBy } from '../triage/checkout-collection.js';
import type { CheckoutQueueType } from '../triage/queue-list.js';
import type { Checkout, CheckoutStatus, EndReason } from './state.js';

/** Whether a Message can be given Replay; when not, why (shown to the Operator). */
export type ReplayAvailability = { available: true } | { available: false; reason: string };

/** A row of the Message list. */
export interface MessageRow extends MessageSummary {
  /** The Message's Decision; Keep until told otherwise. */
  decision: Decision;
  replay: ReplayAvailability;
}

export interface CheckoutView {
  id: string;
  profile: string;
  /** Whether the Checkout's Broker Profile is a Protected Profile. */
  protectedProfile: boolean;
  vhost: string;
  queue: string;
  queueType: CheckoutQueueType;
  /** The Operator who started it. */
  operator: string;
  startedAt: string;
  status: CheckoutStatus;
  /** Why the Checkout was lost; null unless status is "lost". */
  lostReason: string | null;
  /** Why the Checkout ended; null unless status is "ended". */
  endReason: EndReason | null;
  /** Ready Messages in the queue when it started; the UI shows "<heldCount> of ~<readyAtStart> held". */
  readyAtStart: number;
  /** Messages held (and listed); 0 once the Checkout is over. */
  heldCount: number;
  heldBytes: number;
  limits: CheckoutLimits;
  /** Which limit kept the Checkout from holding every ready Message; null when none did. */
  limitedBy: LimitedBy | null;
  /** The queue's effective delivery-limit (quorum); null when none. */
  deliveryLimit: number | null;
  /** Held Messages in queue order. */
  messages: MessageRow[];
  /** Messages per Decision (Discard, Replay, Move per destination, Keep last), for the Apply confirmation. */
  decisionSummary: DecisionSummaryLine[];
  /** The summary on one line, e.g. "12 Discard, 40 Replay, 3 Move to orders.manual, 145 Keep". */
  decisionSummaryText: string;
  /** The confirmation an Apply of the current Decisions needs. */
  applyConfirmation: ApplyConfirmation;
}

export function queueInfo(c: Checkout): QueueInfo {
  return { type: c.queueType, deliveryLimit: c.deliveryLimit, deadLetterExchange: c.deadLetterExchange };
}

export function view(c: Checkout): CheckoutView {
  const info = queueInfo(c);
  const handles = [...c.held.keys()];
  const decisionSummary = summarizeDecisions(handles, c.decisions);
  return {
    id: c.id,
    profile: c.profile.name,
    protectedProfile: c.profile.protected,
    vhost: c.vhost,
    queue: c.queue,
    queueType: c.queueType,
    operator: c.operator,
    startedAt: c.startedAt.toISOString(),
    status: c.status,
    lostReason: c.lostReason,
    endReason: c.endReason,
    readyAtStart: c.readyAtStart,
    heldCount: c.held.size,
    heldBytes: c.heldBytes,
    limits: c.limits,
    limitedBy: c.limitedBy,
    deliveryLimit: c.deliveryLimit,
    messages: [...c.held.entries()].map(([handle, m]) => {
      const origin = replayOrigin(m.properties.headers);
      return {
        ...messageSummary(handle, m, info),
        decision: c.decisions.get(handle) ?? { kind: 'keep' },
        replay: origin.ok ? { available: true } : { available: false, reason: origin.reason },
      };
    }),
    decisionSummary,
    decisionSummaryText: summaryText(decisionSummary),
    applyConfirmation: applyConfirmationFor({
      protectedProfile: c.profile.protected,
      actionCount: handles.filter((h) => c.decisions.has(h)).length,
    }),
  };
}
