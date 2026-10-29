// The state of one Checkout, as the manager keeps it in memory.
import type * as amqp from 'amqplib';
import type { Operator } from '../operator.js';
import type { QueueRef } from '../profiles.js';
import type { CheckoutLimits, LimitedBy } from '../triage/checkout-collection.js';
import type { CheckoutTiming } from '../triage/checkout-timing.js';
import type { ApplyProgressTracker } from '../apply/progress.js';
import type { ActionDecision } from '../triage/decisions.js';
import type { CheckoutQueueType } from '../triage/queue-list.js';
import type { Role } from '../../shared/roles.js';
import type { AppliedResult, CheckoutStatus, DiedAgain, EndReason } from '../../shared/checkout.js';

export type { AppliedResult, CheckoutStatus, EndReason };

/**
 * The status the manager keeps. A Checkout waiting for Approval is `active`
 * with an `approvalRequest`; the view reports it as `awaiting_approval`.
 */
export type CheckoutState = Exclude<CheckoutStatus, 'awaiting_approval'>;

/** A request for Approval of the Checkout's Apply, while it waits. */
export interface ApprovalRequest {
  requestedAt: Date;
  /** The requester's Role on the profile when they asked: the approved Apply records it. */
  role: Role;
  /** The Replay Rate frozen with the Decisions, which the approved Apply runs at; null when unthrottled. */
  rate: number | null;
}

/**
 * How the last request for Approval stopped waiting: withdrawn by the
 * requester, approved or rejected by `by` (display name), or cancelled by the
 * Checkout's end (its status and end or lost reason say which).
 */
export type ApprovalClosed =
  | { how: 'withdrawn' }
  | { how: 'approved' | 'rejected'; by: string }
  | { how: 'cancelled' };

/** The last rejection of a request for Approval, kept until the next request. */
export interface Rejection {
  reason: string;
  /** The approver who rejected it (display name). */
  rejectedBy: string;
  at: Date;
}

export interface Checkout extends QueueRef {
  id: string;
  /** Who started it: `id` keys one active Checkout per Operator, `displayName` is shown. */
  operator: Operator;
  /**
   * Who the broker sees acting on the Checkout's connection, recorded in its
   * Audit Entries: the profile's shared user, or the owner's token user (ADR
   * 0008). An approved Apply runs on this connection, so as the owner.
   */
  brokerUser: string;
  queueType: CheckoutQueueType;
  /** The queue's effective delivery-limit (quorum); null when none. */
  deliveryLimit: number | null;
  /** Whether the queue dead-letters (argument or policy): a Message past its Delivery Budget is dead-lettered, not dropped. */
  deadLetterExchange: boolean;
  startedAt: Date;
  timing: CheckoutTiming;
  /** startedAt plus the time limit: the Checkout ends itself then. */
  endsAt: Date;
  /** Ends the Checkout at endsAt; cleared once it is over. */
  timeLimitTimer: NodeJS.Timeout | undefined;
  /** Ends the Checkout when no heartbeat arrives for the heartbeat window; refreshed by each heartbeat. */
  heartbeatTimer: NodeJS.Timeout | undefined;
  status: CheckoutState;
  /**
   * Team Mode, a Protected Profile with `requireApproval`: an Apply with any
   * Decision other than Keep waits for a second Operator's Approval.
   */
  requireApproval: boolean;
  /** Set while the Checkout waits for Approval (its Decisions are frozen); cleared by withdraw, approve, reject, or its end. */
  approvalRequest: ApprovalRequest | null;
  /** How the last request stopped waiting, so a late approver is told why; null while one waits or none was made. */
  approvalClosed: ApprovalClosed | null;
  /** The last request's rejection, shown to the requester until the next request. */
  rejection: Rejection | null;
  lostReason: string | null;
  endReason: EndReason | null;
  /** Ready Messages in the queue when the Checkout started (passive declare). */
  readyAtStart: number;
  limits: CheckoutLimits;
  /** Which limit kept the Checkout from holding every ready Message; null when none did. */
  limitedBy: LimitedBy | null;
  connection: amqp.ChannelModel | undefined;
  /** The channel the Messages are held on. */
  channel: amqp.Channel | undefined;
  /** Held deliveries in queue order, keyed by delivery tag (the Message handle). */
  held: Map<number, amqp.ConsumeMessage>;
  /** Deliveries past the byte limit: not shown, returned right after the held ones. */
  overflow: amqp.ConsumeMessage[];
  heldBytes: number;
  /** The held Messages that are Died Again, by Message handle; read from the audit store once they are held. */
  diedAgain: Map<number, DiedAgain>;
  /** Decisions other than Keep, by Message handle (staging.ts); a Message missing here is Keep. */
  decisions: Map<number, ActionDecision>;
  /**
   * The Apply running in the background, if any. Ending the Checkout (the
   * Operator, shutdown) waits for it, so a Message whose step is done is never
   * returned and a step is never cut short; the time limit asks it to stop
   * before its next step.
   */
  applying: RunningApply | null;
  /** The progress of the Checkout's Apply, from the moment it starts; kept once it has run. */
  applyProgress: ApplyProgressTracker | null;
  /** The Apply's result, once it has run. */
  lastApply: AppliedResult | null;
}

/** An Apply running in the background on a Checkout (manager.ts). */
export interface RunningApply {
  /** Settles once the Apply has run and the Checkout has ended; never rejects. */
  settled: Promise<void>;
  /** Set to make the executor attempt no further step; null while it goes on. */
  stop: ApplyStop | null;
  /** Aborted together with setting `stop`, so a wait for the next paced step ends at once. */
  stopped: AbortController;
}

/** Why an Apply attempts no further step, and how the Checkout ends afterwards. */
export interface ApplyStop {
  /** The reason of every step left `not-attempted`. */
  reason: string;
  endReason: EndReason;
  /** The Operator who stopped it (display name), for `applyProgress.stoppedBy`; null for the time limit. */
  stoppedBy: string | null;
}
