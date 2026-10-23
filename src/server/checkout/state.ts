// The state of one Checkout, as the manager keeps it in memory.
import type * as amqp from 'amqplib';
import type { Operator } from '../operator.js';
import type { QueueRef } from '../profiles.js';
import type { CheckoutLimits, LimitedBy } from '../triage/checkout-collection.js';
import type { CheckoutTiming } from '../triage/checkout-timing.js';
import type { ActionDecision } from '../triage/decisions.js';
import type { CheckoutQueueType } from '../triage/queue-list.js';
import type { AppliedResult, CheckoutStatus, EndReason } from '../../shared/checkout.js';

export type { AppliedResult, CheckoutStatus, EndReason };

export interface Checkout extends QueueRef {
  id: string;
  /** Who started it: `id` keys one active Checkout per Operator, `displayName` is shown. */
  operator: Operator;
  queueType: CheckoutQueueType;
  /** The queue's effective delivery-limit (quorum); null when none. */
  deliveryLimit: number | null;
  /** Whether the queue dead-letters (argument or policy): a Message past its Delivery Budget is dead-lettered, not dropped. */
  deadLetterExchange: boolean;
  startedAt: Date;
  timing: CheckoutTiming;
  /** startedAt plus the time limit: the Checkout ends itself then. */
  expiresAt: Date;
  /** Ends the Checkout at expiresAt; cleared once it is over. */
  timeLimitTimer: NodeJS.Timeout | undefined;
  /** Ends the Checkout when no heartbeat arrives for the heartbeat window; refreshed by each heartbeat. */
  heartbeatTimer: NodeJS.Timeout | undefined;
  status: CheckoutStatus;
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
  /** Decisions other than Keep, by Message handle (staging.ts); a Message missing here is Keep. */
  decisions: Map<number, ActionDecision>;
  /**
   * The Apply in progress, if any. Ending the Checkout (the Operator, its
   * time limit, a missing heartbeat, shutdown) waits for it, so a Message
   * whose step is done is never returned and a step is never cut short.
   */
  applying: Promise<unknown> | null;
  /** The Apply's result, once it has run. */
  lastApply: AppliedResult | null;
}
