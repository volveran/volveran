// Collecting a Checkout's Messages (ADR 0006): consume the N oldest Messages
// with prefetch N, then cancel the consumer so later arrivals stay in the
// queue. Deliveries the Checkout must not hold (late ones, see
// CheckoutCollection) go straight back with basic.nack(requeue), which costs
// a quorum Message no Delivery Budget. On quorum queues the consumer carries
// `x-consumer-timeout`, the backstop past the Checkout's own time limit;
// classic queues reject the argument (and never time a consumer out).
import type * as amqp from 'amqplib';
import { CheckoutCollection } from '../triage/checkout-collection.js';
import { CheckoutError } from './errors.js';

/** How long to wait for the N deliveries before settling for fewer (the queue may shrink meanwhile). */
const COLLECT_TIMEOUT_MS = 5_000;

export interface Collected {
  /** Held deliveries in queue order. */
  held: amqp.ConsumeMessage[];
  /** Deliveries past the byte limit, in queue order; returned after the held ones. */
  overflow: amqp.ConsumeMessage[];
  heldBytes: number;
}

export interface CollectOptions {
  /** How many Messages to take (N); at least 1. */
  expected: number;
  maxBytes: number;
  /** The consumer's `x-consumer-timeout` (quorum queues only); undefined sets none. */
  consumerTimeoutMs?: number;
  /** Called when the broker cancels the consumer (queue deleted, consumer timeout). */
  onBrokerCancel(): void;
  /** False once the Checkout is lost: its channel or connection is gone. */
  active(): boolean;
  /** Test seam: awaited once collection has stopped waiting for deliveries, before the consumer is cancelled. */
  afterWait?(): Promise<void>;
}

export async function collect(channel: amqp.Channel, queue: string, options: CollectOptions): Promise<Collected> {
  const collection = new CheckoutCollection<amqp.ConsumeMessage>(options.expected, options.maxBytes);
  await channel.prefetch(options.expected);
  let consumerTag: string | undefined;
  await new Promise<void>((resolve, reject) => {
    const stopWaiting = () => {
      clearTimeout(timer);
      collection.close();
      resolve();
    };
    const timer = setTimeout(stopWaiting, COLLECT_TIMEOUT_MS);
    channel
      .consume(
        queue,
        (m) => {
          if (m === null) {
            clearTimeout(timer);
            options.onBrokerCancel();
            return reject(new CheckoutError('checkout_failed', `The broker cancelled the Checkout's consumer on "${queue}".`));
          }
          // A late delivery is returned only after the cancel: returned now, it would come straight back.
          collection.offer(m, m.content.length);
          if (collection.complete) stopWaiting();
        },
        {
          noAck: false,
          ...(options.consumerTimeoutMs === undefined
            ? {}
            : { arguments: { 'x-consumer-timeout': options.consumerTimeoutMs } }),
        },
      )
      .then((ok) => (consumerTag = ok.consumerTag))
      .catch((err: Error) => {
        clearTimeout(timer);
        reject(new CheckoutError('checkout_failed', `Cannot consume from "${queue}": ${err.message}`));
      });
  });

  await options.afterWait?.();
  if (!options.active()) throw new CheckoutError('checkout_failed', 'The Checkout was lost while collecting its Messages.');
  if (consumerTag) await channel.cancel(consumerTag);
  for (const m of collection.late) channel.nack(m, false, true);

  return { held: collection.held, overflow: collection.overflow, heldBytes: collection.heldBytes };
}
