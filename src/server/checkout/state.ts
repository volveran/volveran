// The state of one Checkout, as the manager keeps it in memory.
import type * as amqp from 'amqplib';
import type { Operator } from '../operator.js';
import type { QueueRef } from '../profiles.js';
import type { CheckoutLimits, LimitedBy } from '../triage/checkout-collection.js';
import type { CheckoutQueueType } from '../triage/queue-list.js';

/** `lost`: the Checkout ended without Volverán ending it (a Lost Checkout). */
export type CheckoutStatus = 'active' | 'ended' | 'lost';

/** Why an ended Checkout ended: the Operator ended it, or the app shut down. */
export type EndReason = 'operator' | 'shutdown';

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
