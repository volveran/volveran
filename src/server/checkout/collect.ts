// Collecting a Checkout's Messages (ADR 0006): consume the N oldest Messages
// in windows, then cancel the consumer so later arrivals stay in the queue.
//
// Each window is a consumer of its own with the window as its prefetch, on
// the same channel, cancelled once it has delivered: RabbitMQ does not widen
// a running consumer's prefetch, and a new consumer continues with the next
// ready Messages in order (docs/rabbitmq-behaviour.md, "Prefetch"). The
// window comes from the remaining bytes at the average body size so far
// (collectionWindow), so past the byte limit at most one window of bodies
// sits in memory as overflow, not the whole N. The windows add up to at most
// N, so the Checkout never takes more than N.
//
// Deliveries the Checkout must not hold (late ones, see CheckoutCollection)
// go straight back with basic.nack(requeue), which costs a quorum Message no
// Delivery Budget. On quorum queues each consumer carries
// `x-consumer-timeout`, the backstop past the Checkout's own time limit;
// classic queues reject the argument (and never time a consumer out).
import type * as amqp from 'amqplib';
import { CheckoutCollection } from '../triage/checkout-collection.js';
import { CheckoutError } from './errors.js';

/** How long to wait for a window's next delivery before settling for fewer (the queue may shrink meanwhile). */
const COLLECT_TIMEOUT_MS = 5_000;

export interface Collected {
  /** Held deliveries in queue order. */
  held: amqp.ConsumeMessage[];
  /** Deliveries past the byte limit, in queue order; returned after the held ones. At most one window. */
  overflow: amqp.ConsumeMessage[];
  heldBytes: number;
  /** The prefetch of each window, in order. */
  windows: number[];
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
  const windows: number[] = [];
  for (;;) {
    const window = collection.nextWindow();
    windows.push(window);
    const { consumerTag, timedOut } = await consumeWindow(channel, queue, collection, window, options);
    const last = timedOut || collection.done;
    // A late delivery is returned only after the cancel: returned now, it would come straight back.
    if (timedOut) collection.close();
    if (last) {
      await options.afterWait?.();
      if (!options.active()) throw new CheckoutError('checkout_failed', 'The Checkout was lost while collecting its Messages.');
    }
    // Unless the wait timed out, the window has been delivered: the consumer
    // has no prefetch left and nothing is on its way. (A delivery after the
    // cancel-ok would make amqplib fail the connection: "Unknown consumer".)
    await channel.cancel(consumerTag);
    if (last) break;
  }
  collection.close();
  for (const m of collection.late) channel.nack(m, false, true);

  return { held: collection.held, overflow: collection.overflow, heldBytes: collection.heldBytes, windows };
}

/**
 * Consumes with prefetch `window` until the window is delivered, or no
 * delivery came for COLLECT_TIMEOUT_MS. The consumer stays registered: the
 * caller cancels it.
 */
async function consumeWindow(
  channel: amqp.Channel,
  queue: string,
  collection: CheckoutCollection<amqp.ConsumeMessage>,
  window: number,
  options: CollectOptions,
): Promise<{ consumerTag: string; timedOut: boolean }> {
  await channel.prefetch(window);
  let delivered = 0;
  let timedOut = false;
  let timer: NodeJS.Timeout | undefined;
  let finish!: () => void;
  let fail!: (err: Error) => void;
  const windowDone = new Promise<void>((resolve, reject) => {
    finish = () => {
      clearTimeout(timer);
      resolve();
    };
    fail = (err) => {
      clearTimeout(timer);
      reject(err);
    };
  });
  const wait = () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      timedOut = true;
      finish();
    }, COLLECT_TIMEOUT_MS);
  };
  wait();
  const consuming = channel
    .consume(
      queue,
      (m) => {
        if (m === null) {
          options.onBrokerCancel();
          return fail(new CheckoutError('checkout_failed', `The broker cancelled the Checkout's consumer on "${queue}".`));
        }
        collection.offer(m, m.content.length);
        delivered++;
        // Past the byte limit the rest of the window still arrives, as overflow.
        if (delivered >= window) finish();
        else wait();
      },
      {
        noAck: false,
        ...(options.consumerTimeoutMs === undefined ? {} : { arguments: { 'x-consumer-timeout': options.consumerTimeoutMs } }),
      },
    )
    .catch((err: Error) => {
      const failure = new CheckoutError('checkout_failed', `Cannot consume from "${queue}": ${err.message}`);
      fail(failure);
      throw failure;
    });
  await windowDone.catch((err: Error) => {
    consuming.catch(() => {});
    throw err;
  });
  const { consumerTag } = await consuming;
  return { consumerTag, timedOut };
}
