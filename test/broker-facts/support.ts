// Helpers for the broker-facts suite: declare throwaway queues and hold
// Messages unacknowledged while watching what the broker sends back.
import type * as amqp from 'amqplib';
import { connect, eventually, openChannel, openConfirmChannel, sleep, uniqueName } from '../broker/client.js';

export type QueueType = 'classic' | 'quorum';
export const queueTypes: QueueType[] = ['classic', 'quorum'];

export interface Scratch {
  conn: amqp.ChannelModel;
  /** A confirm channel for setup, publishing, gets and passive declares; never used to consume. */
  ch: amqp.ConfirmChannel;
  /** Declares a fresh queue that is deleted in `close`. */
  queue(prefix: string, args?: Record<string, unknown>): Promise<string>;
  /** Declares a fresh exchange that is deleted in `close`. */
  exchange(prefix: string, type: string): Promise<string>;
  /** Publishes `bodies` to `queue` through the default exchange and waits for their confirms. */
  publish(queue: string, bodies: string[], options?: amqp.Options.Publish): Promise<void>;
  /** Ready Messages and consumers, from a passive queue.declare. */
  check(queue: string): Promise<amqp.Replies.AssertQueue>;
  /** Takes every ready Message with auto-ack and returns their bodies, oldest first. */
  bodies(queue: string): Promise<string[]>;
  close(): Promise<void>;
}

/** A Scratch closed when the test finishes (safe in concurrent tests). */
export async function scratchFor(ctx: { onTestFinished(fn: () => Promise<void>): void }): Promise<Scratch> {
  const s = await scratch();
  ctx.onTestFinished(() => s.close());
  return s;
}

/** A connection with helpers for declaring throwaway queues. */
export async function scratch(): Promise<Scratch> {
  const conn = await connect();
  const ch = await openConfirmChannel(conn);
  const declared: string[] = [];
  const exchanges: string[] = [];
  const self: Scratch = {
    conn,
    ch,
    async queue(prefix, args = {}) {
      const name = uniqueName(prefix);
      await ch.assertQueue(name, { durable: true, arguments: args });
      declared.push(name);
      return name;
    },
    async exchange(prefix, type) {
      const name = uniqueName(prefix);
      await ch.assertExchange(name, type, { durable: false });
      exchanges.push(name);
      return name;
    },
    async publish(queue, bodies, options) {
      for (const body of bodies) ch.sendToQueue(queue, Buffer.from(body), options);
      await ch.waitForConfirms();
    },
    check: (queue) => ch.checkQueue(queue),
    async bodies(queue) {
      const out: string[] = [];
      for (;;) {
        const m = await ch.get(queue, { noAck: true });
        if (!m) return out;
        out.push(m.content.toString());
      }
    },
    async close() {
      const cleanup = await openChannel(conn).catch(() => undefined);
      for (const q of declared) await cleanup?.deleteQueue(q).catch(() => {});
      for (const x of exchanges) await cleanup?.deleteExchange(x).catch(() => {});
      await conn.close().catch(() => {});
    },
  };
  return self;
}

export interface Holder {
  ch: amqp.Channel;
  consumerTag: string;
  /** Deliveries received so far, in order. */
  held: amqp.ConsumeMessage[];
  /** Resolves with the time the broker sent basic.cancel. */
  brokerCancel: Promise<number>;
  /** Resolves with the error the broker closed the channel with. */
  channelError: Promise<Error>;
  /** The time the consumer was registered. */
  startedAt: number;
}

/**
 * Consumes `count` Messages from `queue` on a new channel of `conn` without
 * acking them, and records whether the broker cancels the consumer or
 * closes the channel afterwards.
 */
export async function hold(
  conn: amqp.ChannelModel,
  queue: string,
  count: number,
  options: amqp.Options.Consume = {},
): Promise<Holder> {
  const ch = await conn.createChannel();
  let onCancel!: (at: number) => void;
  let onError!: (err: Error) => void;
  const brokerCancel = new Promise<number>((resolve) => (onCancel = resolve));
  const channelError = new Promise<Error>((resolve) => (onError = resolve));
  ch.on('error', (err: Error) => onError(err));
  await ch.prefetch(count);
  const held: amqp.ConsumeMessage[] = [];
  const startedAt = Date.now();
  const { consumerTag } = await ch.consume(
    queue,
    (m) => {
      if (m) held.push(m);
      else onCancel(Date.now());
    },
    options,
  );
  const deadline = Date.now() + 5_000;
  while (held.length < count) {
    if (Date.now() > deadline) throw new Error(`only ${held.length} of ${count} deliveries arrived from ${queue}`);
    await sleep(20);
  }
  return { ch, consumerTag, held, brokerCancel, channelError, startedAt };
}

/** Resolves with `promise`'s value, or with 'nothing' if it has not settled after `ms`. */
export async function within<T>(promise: Promise<T>, ms: number): Promise<T | 'nothing'> {
  return Promise.race([promise, sleep(ms).then(() => 'nothing' as const)]);
}

/** Headers of a delivery that count returns. */
export function counts(m: amqp.Message): { deliveryCount: unknown; acquiredCount: unknown } {
  return {
    deliveryCount: m.properties.headers?.['x-delivery-count'],
    acquiredCount: m.properties.headers?.['x-acquired-count'],
  };
}

/** Error message of an amqplib operation the broker refused. */
export async function refusal(op: Promise<unknown>): Promise<string> {
  try {
    await op;
  } catch (err) {
    return (err as Error).message;
  }
  return 'accepted';
}

/**
 * basic.get that waits up to `waitMs` for a Message: a return on a quorum
 * queue is processed asynchronously, so an immediate get can miss it.
 * Resolves with false if nothing arrives.
 */
export async function next(ch: amqp.Channel, queue: string, waitMs = 1_000, options?: amqp.Options.Get): Promise<amqp.GetMessage | false> {
  const deadline = Date.now() + waitMs;
  for (;;) {
    const m = await ch.get(queue, options);
    if (m || Date.now() > deadline) return m;
    await sleep(25);
  }
}

/** Takes the one Message in `q` with auto-ack, waiting up to 3 s for it. */
export async function take(ch: amqp.Channel, q: string): Promise<amqp.GetMessage> {
  return eventually(async () => {
    const m = await ch.get(q, { noAck: true });
    if (!m) throw new Error(`nothing in ${q}`);
    return m;
  }, 3_000, 100);
}

/** Takes the one Message in `q` and rejects it without requeue, so it is dead-lettered. */
export async function deadLetterFrom(ch: amqp.Channel, q: string): Promise<void> {
  const m = await eventually(async () => {
    const got = await ch.get(q);
    if (!got) throw new Error(`nothing in ${q}`);
    return got;
  }, 3_000, 100);
  ch.reject(m, false);
  await ch.checkQueue(q);
}
