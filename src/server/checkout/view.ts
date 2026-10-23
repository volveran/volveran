// What the API returns for a Checkout.
import { messageSummary, type MessageSummary, type QueueInfo } from '../triage/message-view.js';
import type { CheckoutLimits, LimitedBy } from '../triage/checkout-collection.js';
import { remainingMs } from '../triage/checkout-timing.js';
import type { CheckoutQueueType } from '../triage/queue-list.js';
import type { Checkout, CheckoutStatus, EndReason } from './state.js';

export interface CheckoutView {
  id: string;
  profile: string;
  /** Whether the Checkout's Broker Profile is a Protected Profile. */
  protectedProfile: boolean;
  vhost: string;
  queue: string;
  queueType: CheckoutQueueType;
  /** The Operator who started it, as shown (display name). */
  operator: string;
  startedAt: string;
  /** How long the Checkout may hold Messages. */
  timeLimitMs: number;
  /** When the Checkout ends itself (startedAt plus timeLimitMs). */
  expiresAt: string;
  /** Milliseconds left until expiresAt, measured by the server (immune to browser clock skew); 0 once over. */
  remainingMs: number;
  /** The browser must POST /api/checkouts/:id/heartbeat at least this often, or the Checkout ends. */
  heartbeatWindowMs: number;
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
  messages: MessageSummary[];
}

export function queueInfo(c: Checkout): QueueInfo {
  return { type: c.queueType, deliveryLimit: c.deliveryLimit, deadLetterExchange: c.deadLetterExchange };
}

export function view(c: Checkout): CheckoutView {
  const info = queueInfo(c);
  return {
    id: c.id,
    profile: c.profile.name,
    protectedProfile: c.profile.protected,
    vhost: c.vhost,
    queue: c.queue,
    queueType: c.queueType,
    operator: c.operator.displayName,
    startedAt: c.startedAt.toISOString(),
    timeLimitMs: c.timing.timeLimitMs,
    expiresAt: c.expiresAt.toISOString(),
    remainingMs: c.status === 'active' ? remainingMs(c.expiresAt, new Date()) : 0,
    heartbeatWindowMs: c.timing.heartbeatWindowMs,
    status: c.status,
    lostReason: c.lostReason,
    endReason: c.endReason,
    readyAtStart: c.readyAtStart,
    heldCount: c.held.size,
    heldBytes: c.heldBytes,
    limits: c.limits,
    limitedBy: c.limitedBy,
    deliveryLimit: c.deliveryLimit,
    messages: [...c.held.entries()].map(([handle, m]) => messageSummary(handle, m, info)),
  };
}
