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
 * `applying`: active, with its Apply running in the background
 * (`applyProgress`); it ends once the Apply has run.
 * `lost`: the Checkout ended without Volverán ending it (a Lost Checkout).
 */
export type CheckoutStatus = 'active' | 'awaiting_approval' | 'applying' | 'ended' | 'lost';

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
  /** What Spring AMQP or MassTransit wrote about the failure; null when neither did. */
  failureDetails: FailureDetails | null;
}

/**
 * The exception and context a client framework wrote into a Message's
 * headers when it gave up on it (src/server/triage/failure-details.ts).
 * Fields the framework did not write are null.
 */
export interface FailureDetails {
  /** Spring AMQP's RepublishMessageRecoverer, or MassTransit. */
  framework: 'spring' | 'masstransit';
  exceptionType: string | null;
  message: string | null;
  stackTrace: string | null;
  consumerType: string | null;
  messageType: string | null;
  /** When the consumer failed: ISO time, or the header as written when it does not read as a time. */
  faultAt: string | null;
  retryCount: number | null;
  redeliveryCount: number | null;
  /** MassTransit's `MT-Host-*` headers, by the name after the prefix (e.g. `MachineName`). */
  host: Record<string, string> | null;
  /** MassTransit's `MT-Reason`: a fault, or a Message no consumer handled (skip). */
  reason: 'fault' | 'skip' | null;
  /** Spring AMQP: where the Message was first published. */
  originalExchange: string | null;
  originalRoutingKey: string | null;
  /** MassTransit: the queue named in `MT-Fault-InputAddress`, the one whose consumer failed. */
  inputQueue: string | null;
  /** Other framework headers, as text: Spring's other `x-exception-*`, MassTransit's addresses. */
  extra: Record<string, string>;
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
 * not-attempted: Apply stopped before it (the Checkout stopped being active
 * or reached its time limit, or this version cannot carry out its Decision);
 * it goes back to the queue.
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

/**
 * How far a Checkout's Apply has got. Counts are of the Apply's steps (every
 * Decision other than Keep); `remaining` is the steps neither done, failed
 * nor not attempted yet.
 */
export interface ApplyProgress {
  total: number;
  done: number;
  failed: number;
  notAttempted: number;
  remaining: number;
  /** The Replay Rate the Apply runs at, in Messages per second; null when it runs as fast as the broker confirms. */
  rate: number | null;
  /** ISO 8601. */
  startedAt: string;
  /** When the Apply should end at its pace so far (ISO 8601); null until a step has run. */
  estimatedEndAt: string | null;
  /** The Operator who stopped the Apply (display name); null unless one did. */
  stoppedBy: string | null;
  /**
   * running: carrying out steps. canary_watch: the Canary is out and watched
   * for the Watch Window. canary_done: the watch is over; the Apply waits for
   * the Operator to continue or stop.
   */
  phase: ApplyPhase;
}

export type ApplyPhase = 'running' | 'canary_watch' | 'canary_done';

/**
 * watching: the Watch Window runs. died_again: a copy of the Canary was
 * dead-lettered again. not_dead_lettered: none was while it was watched.
 * unwatched: it could not be watched (`watchProblem` says why), so only the
 * Replay's outcome is known. failed: the Canary's Replay failed.
 */
export type CanaryStatus = 'watching' | 'died_again' | 'not_dead_lettered' | 'unwatched' | 'failed';

/** The Canary of a Checkout's Apply, from the moment its Replay starts. */
export interface CanaryView {
  handle: number;
  messageId: string | null;
  /** The Audit Entry of the Canary's Replay. */
  auditEntryId: number;
  status: CanaryStatus;
  /** When the watch ends, or ended (earlier when the Operator continued or stopped first); null until it starts. */
  watchEndsAt: string | null;
  /** The new dead-letter reason of a Canary that died again (or the framework's exception); null otherwise. */
  deadLetterReason: string | null;
  /** The Failure Details of the copy that died again, when a framework wrote any. */
  failureDetails: FailureDetails | null;
  /** Why the Canary is unwatched, or why its Replay failed; null otherwise. */
  watchProblem: string | null;
}

/** Whether a held Message could be watched as the Canary, and if not why. */
export type CanaryWatchability = { watchable: true } | { watchable: false; reason: string };

/** What the Apply confirmation shows for a Canary. */
export interface CanaryConfirmation {
  /** The Broker Profile's Watch Window. */
  watchWindowMs: number;
  /** The profile's `canary.requiredAbove`: an Apply with more Replays must start with a Canary; null when never required. */
  requiredAbove: number | null;
  /** Whether the current Decisions have more Replays than `requiredAbove`: the Apply (or request) needs a Canary. */
  required: boolean;
  /** The Messages that may be the Canary (Decision Replay), in Checkout order: the first is the default. */
  candidates: Array<{ handle: number; watch: CanaryWatchability }>;
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
  /** The Broker Profile's Replay Rate: the default the rate field starts from, and the most it may be; null when not set. */
  replayRate: { default: number | null; max: number | null };
  /**
   * How long the Replay and Move steps of the current Decisions take at the
   * Replay Rate: the rate frozen with a request for Approval, else the
   * profile's default; null when unthrottled.
   */
  estimatedDurationMs: number | null;
  /** The Canary the Apply may start with (`canary` in the Apply body). */
  canary: CanaryConfirmation;
}

/** A pending request for Approval of a Checkout's Apply. */
export interface ApprovalRequestView {
  /** When the requester asked for Approval (ISO 8601). */
  requestedAt: string;
  /** The Replay Rate frozen with the Decisions, which the approved Apply runs at; null when unthrottled. */
  rate: number | null;
  /** The Canary the approved Apply starts with, frozen with the Decisions; null for none. */
  canary: RequestedCanary | null;
}

/** The Canary frozen with a request for Approval: "starts with a Canary: <message id>". */
export interface RequestedCanary {
  handle: number;
  messageId: string | null;
}

/** The last rejection of the Checkout's request for Approval, shown to the requester until they request again. */
export interface ApprovalRejection {
  /** Why the approver rejected it (required). */
  reason: string;
  /** The Operator who rejected it (display name). */
  rejectedBy: string;
  /** ISO 8601. */
  at: string;
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
  /** Milliseconds since requestedAt, measured by the server. */
  waitingMs: number;
  /** When the Checkout ends itself, and with it the request (ISO 8601). */
  endsAt: string;
  /** Milliseconds left until endsAt, measured by the server. */
  remainingMs: number;
  /** Messages per Decision. */
  decisionSummary: DecisionSummaryLine[];
  decisionSummaryText: string;
  /** The Replay Rate the approved Apply runs at, in Messages per second; null when unthrottled. */
  rate: number | null;
  /** The Canary the approved Apply starts with; null for none. */
  canary: RequestedCanary | null;
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
  /** The last request's rejection, until the next request; null otherwise. The Checkout is back in staging. */
  rejection: ApprovalRejection | null;
  /** The progress of the Checkout's Apply, from the moment it starts (kept once it has run); null before. */
  applyProgress: ApplyProgress | null;
  /** The result of the Checkout's Apply (outcome per Message), once it has run; null before. */
  lastApply: AppliedResult | null;
  /** The Canary of the Checkout's Apply, from the moment its Replay starts; null without one. */
  canary: CanaryView | null;
}
