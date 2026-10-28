// A Checkout as the API sends it (src/server/checkout/view.ts), with its held
// Messages and the outcome of its Apply. Types only, shared by the server
// and the web app.
import type { AuditAction } from './audit.js';
import type { Decision, DecisionSummaryLine } from './decisions.js';

/** The queue types a Checkout can hold Messages from. */
export type CheckoutQueueType = 'classic' | 'quorum';

/**
 * `awaiting_approval`: active, with its Decisions frozen until a second
 * Operator approves the Apply (or the requester withdraws the request).
 * `lost`: the Checkout ended without Volverán ending it (a Lost Checkout).
 */
export type CheckoutStatus = 'active' | 'awaiting_approval' | 'ended' | 'lost';

/**
 * Why an ended Checkout ended: the Operator ended it, it was Applied, the app
 * shut down, it reached its time limit, or the browser stopped sending
 * heartbeats.
 */
export type EndReason = 'operator' | 'applied' | 'shutdown' | 'time-limit' | 'no-heartbeat';

export interface CheckoutLimits {
  /** Most Messages one Checkout holds (default 1,000). */
  maxMessages: number;
  /** Most body bytes one Checkout holds (default 100 MB). */
  maxBytes: number;
}

/** Which limit kept a Checkout from holding every ready Message. */
export type LimitedBy = 'messages' | 'bytes';

/** Who holds a queue in a Checkout. */
export interface CheckoutHolder {
  /** The Operator who started the Checkout, as shown (display name). */
  operator: string;
  /** ISO time the Checkout started. */
  since: string;
}

export interface DeliveryBudget {
  /** Abnormal returns left before the broker drops or dead-letters the Message; never negative. */
  remaining: number;
  /** Set when `remaining` is 1 or less. */
  warning: string | null;
}

export interface MessageSummary {
  /** Per-Checkout handle; Messages sharing a message_id still have distinct handles. */
  handle: number;
  messageId: string | null;
  routingKey: string;
  /** ISO time from the `timestamp` property, or null. */
  timestamp: string | null;
  deadLetterReason: string | null;
  /** The queue of the most recent `x-death` entry: where the Message was dead-lettered from. */
  originalQueue: string | null;
  /** Body size in bytes. */
  size: number;
  /** Quorum queues with a delivery limit only; null otherwise. */
  deliveryBudget: DeliveryBudget | null;
}

export interface XDeathEntry {
  queue: string | null;
  reason: string | null;
  count: number | null;
  /** First dead-lettering for this queue and reason, ISO time. */
  time: string | null;
  /** Exchange and routing keys the Message was published with before entering `queue`. */
  exchange: string | null;
  routingKeys: string[];
  originalExpiration: string | null;
}

export type RenderedBody =
  | { kind: 'json'; size: number; text: string }
  | { kind: 'text'; size: number; text: string }
  | { kind: 'binary'; size: number; hex: string; base64: string };

export interface MessageDetail extends MessageSummary {
  exchange: string;
  redelivered: boolean;
  deliveryCount: number | null;
  deliveryLimit: number | null;
  /** Every AMQP property that is set, except headers, as JSON-safe values. */
  properties: Record<string, unknown>;
  headers: Record<string, unknown>;
  xDeath: XDeathEntry[];
  body: RenderedBody;
  /** Null unless the Message is Died Again. */
  diedAgain: DiedAgain | null;
}

/** Whether a Message can be given Replay; when not, why (shown to the Operator). */
export type ReplayAvailability = { available: true } | { available: false; reason: string };

/** The Audit Entry of the Replay, Move or Restore that last sent a Died Again Message out. */
export interface DiedAgainSource {
  auditEntryId: number;
  action: Exclude<AuditAction, 'discard' | 'export'>;
  /** ISO time of the Audit Entry. */
  at: string;
  /** The Operator who acted, as shown (display name). */
  operatorName: string;
  /** The queue the Message was taken from then. */
  fromQueue: string;
}

/**
 * A Message that Volverán Replayed, Moved or Restored and that was
 * dead-lettered again, recognised by its `x-volveran-replay-id` header.
 */
export interface DiedAgain {
  /** The `x-volveran-replay-id` the Message carries. */
  replayId: string;
  /** How many times it has died again: the replay ids followed back through the Audit Entries, this one included. */
  count: number;
  /** Null when no Audit Entry here has the replay id (another Volverán instance sent it out, or the store was reset). */
  last: DiedAgainSource | null;
}

/** A row of the Message list. */
export interface MessageRow extends MessageSummary {
  /** The Message's Decision; Keep until told otherwise. */
  decision: Decision;
  replay: ReplayAvailability;
  /** Null unless the Message is Died Again. */
  diedAgain: DiedAgain | null;
}

/**
 * What happened to one Message in an Apply. done: its Decision was carried
 * out. failed: it was not (the reason says why); it goes back to the queue.
 * not-attempted: Apply stopped before it (the Checkout stopped being active,
 * or this version cannot carry out its Decision); it goes back to the queue.
 * kept: its Decision was Keep.
 */
export type OutcomeStatus = 'done' | 'failed' | 'not-attempted' | 'kept';

export interface MessageOutcome {
  handle: number;
  messageId: string | null;
  decision: Decision;
  status: OutcomeStatus;
  /** Why it failed or was not attempted; null otherwise. */
  reason: string | null;
}

/** The result of a Checkout's Apply. */
export interface AppliedResult {
  /** When the Apply started (ISO 8601). */
  at: string;
  /** One per Message the Checkout held, in Checkout order. */
  outcomes: MessageOutcome[];
  /** The Operator who approved the Apply (display name); null when it needed no Approval. */
  approvedBy: string | null;
}

/** The confirmation an Apply needs beyond the single confirmation. */
export interface ApplyConfirmation {
  /** The operator must type the queue name (`confirmQueueName`) to Apply. */
  typeQueueName: boolean;
  /**
   * Team Mode, Protected Profile with `requireApproval`, any Decision other
   * than Keep: the Apply needs a second Operator's Approval. The requester
   * requests it (POST /api/checkouts/:id/approval-request) instead of Applying.
   */
  approvalRequired: boolean;
}

/** A pending request for Approval of a Checkout's Apply. */
export interface ApprovalRequestView {
  /** When the requester asked for Approval (ISO 8601). */
  requestedAt: string;
}

/** A Checkout waiting for Approval, as GET /api/approvals lists it. */
export interface ApprovalSummary {
  checkoutId: string;
  /** The Operator who requested Approval (display name). */
  requester: string;
  profile: string;
  vhost: string;
  queue: string;
  queueType: CheckoutQueueType;
  /** ISO 8601. */
  requestedAt: string;
  /** When the Checkout ends itself, and with it the request (ISO 8601). */
  endsAt: string;
  /** Milliseconds left until endsAt, measured by the server. */
  remainingMs: number;
  /** Messages per Decision. */
  decisionSummary: DecisionSummaryLine[];
  decisionSummaryText: string;
}

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
  endsAt: string;
  /** Milliseconds left until endsAt, measured by the server (immune to browser clock skew); 0 once over. */
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
  messages: MessageRow[];
  /** Held Messages that are Died Again. */
  diedAgainCount: number;
  /** Messages per Decision (Discard, Replay, Move per destination, Keep last), for the Apply confirmation. */
  decisionSummary: DecisionSummaryLine[];
  /** The summary on one line, e.g. "12 Discard, 40 Replay, 3 Move to orders.manual, 145 Keep". */
  decisionSummaryText: string;
  /** The confirmation an Apply of the current Decisions needs. */
  applyConfirmation: ApplyConfirmation;
  /** The pending request for Approval (status `awaiting_approval`); null otherwise. */
  approvalRequest: ApprovalRequestView | null;
  /** The result of the Checkout's Apply (outcome per Message), once it has run; null before. */
  lastApply: AppliedResult | null;
}
