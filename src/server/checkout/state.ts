// The state of one Checkout, as the manager keeps it in memory.
import type * as amqp from 'amqplib';
import type { QueueRef } from '../profiles.js';
import type { CheckoutLimits, LimitedBy } from '../triage/checkout-collection.js';
import type { CheckoutTiming } from '../triage/checkout-timing.js';
import type { CheckoutQueueType } from '../triage/queue-list.js';

/** `lost`: the Checkout ended without Volverán ending it (a Lost Checkout). */
export type CheckoutStatus = 'active' | 'ended' | 'lost';

/**
 * Why an ended Checkout ended: the Operator ended it, the app shut down, it
 * reached its time limit, or the browser stopped sending heartbeats.
 */
export type EndReason = 'operator' | 'shutdown' | 'time-limit' | 'no-heartbeat';

export interface Checkout extends QueueRef {
  id: string;
  operator: string;
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
}
