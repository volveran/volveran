// The demo's broker: queues, exchanges and bindings of the screenshot
// scenario (test/broker/definitions.json plus what scripts/screenshots/seed.mjs
// declares), in memory, with the Messages of scripts/screenshots/messages.mjs
// dead-lettered into them as RabbitMQ 4 does it. Both Broker Profiles of the
// demo point at this one broker, as in the screenshot run.
//
// Messages are kept as amqplib decodes them (properties, headers with typed
// timestamps), so the views built from them read like the server's. A queue
// counts its held Messages in its depth (RabbitMQ's `messages`, ready plus
// unacknowledged); an ack removes one, a release (Keep) puts it back in place.
//
// Consumers stand for the applications behind the work queues: a Message
// published to a queue with a consumer goes to the consumer instead of
// waiting in the queue. The consumer decides its fate (`consumes` acks it;
// #150 adds one that rejects some, so they die again).
import { scenarioMessages } from '../../../../scripts/screenshots/messages.mjs';

export type QueueType = 'classic' | 'quorum' | 'stream';

/** An AMQP timestamp as amqplib decodes one inside a header table. */
export interface AmqpTimestamp {
  '!': 'timestamp';
  /** Seconds since the epoch. */
  value: number;
}

/** AMQP properties as amqplib decodes them; `timestamp` in seconds. */
export interface AmqpProperties {
  messageId?: string;
  contentType?: string;
  contentEncoding?: string;
  correlationId?: string;
  timestamp?: number;
  type?: string;
  appId?: string;
  deliveryMode?: number;
  headers?: Record<string, unknown>;
}

/** A Message on the broker, as a consumer receives it. */
export interface BrokerMessage {
  /** The exchange and routing key it was last published (or dead-lettered) with. */
  exchange: string;
  routingKey: string;
  redelivered: boolean;
  properties: AmqpProperties;
  content: Uint8Array;
}

/** What happens to a Message handed to a consumer. */
export type Consumer = (message: BrokerMessage, broker: DemoBroker, queue: QueueRef) => void;

export interface QueueRef {
  vhost: string;
  queue: string;
}

export interface QueueSpec {
  vhost: string;
  name: string;
  type: QueueType;
  deadLetterExchange?: string;
  /** Effective delivery-limit (quorum only; RabbitMQ 4 defaults to 20). */
  deliveryLimit?: number;
  /** How many consumers read it (the applications behind the work queues). */
  consumers?: number;
}

interface Queue extends QueueSpec {
  messages: BrokerMessage[];
  held: Set<BrokerMessage>;
  consumer: Consumer | null;
}

export interface ExchangeSpec {
  vhost: string;
  name: string;
  type: 'topic' | 'fanout' | 'direct';
}

export interface BindingSpec {
  vhost: string;
  source: string;
  destination: string;
  routingKey: string;
}

export interface Topology {
  queues: QueueSpec[];
  exchanges: ExchangeSpec[];
  bindings: BindingSpec[];
}

/** The screenshot scenario's vhosts: test/broker/definitions.json, plus the set-ups seed.mjs declares. */
export const SCENARIO_TOPOLOGY: Topology = {
  queues: [
    { vhost: '/', name: 'orders.work', type: 'classic', deadLetterExchange: 'orders.dlx', consumers: 2 },
    { vhost: '/', name: 'orders.dlq', type: 'classic' },
    { vhost: '/', name: 'orders.dlq.quorum', type: 'quorum', deliveryLimit: 20 },
    { vhost: '/', name: 'orders.dlq.quorum-dlx', type: 'quorum', deadLetterExchange: 'orders.dlq.dlx', deliveryLimit: 20 },
    { vhost: '/', name: 'orders.parked', type: 'classic' },
    { vhost: '/', name: 'payments.work', type: 'quorum', deadLetterExchange: 'payments.dlx', deliveryLimit: 20, consumers: 2 },
    { vhost: '/', name: 'payments.dlq', type: 'quorum', deliveryLimit: 5 },
    { vhost: '/', name: 'payments.dlq.classic', type: 'classic' },
    { vhost: '/', name: 'triage.manual', type: 'classic' },
    { vhost: '/', name: 'events.stream', type: 'stream' },
    { vhost: '/', name: 'billing.work', type: 'classic', deadLetterExchange: 'billing.dlx', consumers: 1 },
    { vhost: '/', name: 'shipping.dlq', type: 'classic' },
    { vhost: '/', name: 'notifications.dlq', type: 'classic' },
    { vhost: '/', name: 'inventory.work', type: 'quorum', deadLetterExchange: 'inventory.dlx', deliveryLimit: 20 },
    { vhost: 'other', name: 'other.dlq', type: 'classic' },
  ],
  exchanges: [
    { vhost: '/', name: 'orders', type: 'topic' },
    { vhost: '/', name: 'orders.dlx', type: 'fanout' },
    { vhost: '/', name: 'payments', type: 'topic' },
    { vhost: '/', name: 'payments.dlx', type: 'fanout' },
    { vhost: '/', name: 'orders.dlq.dlx', type: 'fanout' },
    { vhost: '/', name: 'inventory.dlx', type: 'fanout' },
  ],
  bindings: [
    { vhost: '/', source: 'orders', destination: 'orders.work', routingKey: 'orders.#' },
    { vhost: '/', source: 'orders.dlx', destination: 'orders.dlq', routingKey: '' },
    { vhost: '/', source: 'orders.dlx', destination: 'orders.dlq.quorum', routingKey: '' },
    { vhost: '/', source: 'orders.dlx', destination: 'orders.dlq.quorum-dlx', routingKey: '' },
    { vhost: '/', source: 'orders.dlq.dlx', destination: 'orders.parked', routingKey: '' },
    { vhost: '/', source: 'payments', destination: 'payments.work', routingKey: 'payments.#' },
    { vhost: '/', source: 'payments.dlx', destination: 'payments.dlq', routingKey: '' },
    { vhost: '/', source: 'payments.dlx', destination: 'payments.dlq.classic', routingKey: '' },
  ],
};

/** A consumer that processes every Message it gets: the Message is gone. */
export const consumes: Consumer = () => {};

export class DemoBroker {
  readonly #queues = new Map<string, Queue>();
  readonly #exchanges = new Map<string, ExchangeSpec>();
  readonly #bindings: BindingSpec[];

  constructor(topology: Topology) {
    for (const q of topology.queues) this.#queues.set(key(q.vhost, q.name), { ...q, messages: [], held: new Set(), consumer: null });
    for (const e of topology.exchanges) this.#exchanges.set(key(e.vhost, e.name), e);
    this.#bindings = topology.bindings;
  }

  /** The queue's set-up, or undefined when the vhost has no such queue. */
  queue({ vhost, queue }: QueueRef): Readonly<QueueSpec> | undefined {
    return this.#queues.get(key(vhost, queue));
  }

  hasExchange(vhost: string, name: string): boolean {
    return this.#exchanges.has(key(vhost, name));
  }

  /** Messages in the queue, held ones included (RabbitMQ's `messages`). */
  depth(ref: QueueRef): number {
    return this.#queues.get(key(ref.vhost, ref.queue))?.messages.length ?? 0;
  }

  /** Messages in the queue nobody holds. */
  ready(ref: QueueRef): number {
    const q = this.#queues.get(key(ref.vhost, ref.queue));
    return q ? q.messages.length - q.held.size : 0;
  }

  /** Lets `consumer` take every Message published to the queue from now on. */
  consume(ref: QueueRef, consumer: Consumer): void {
    this.#required(ref).consumer = consumer;
  }

  /**
   * Publishes through `exchange` ('' for the default exchange, which routes
   * to the queue named by the routing key). Returns the queues it reached;
   * none means the broker could not route it.
   */
  publish(vhost: string, exchange: string, routingKey: string, message: Omit<BrokerMessage, 'exchange' | 'routingKey' | 'redelivered'>): string[] {
    const targets = this.#route(vhost, exchange, routingKey);
    for (const name of targets) {
      const q = this.#queues.get(key(vhost, name))!;
      const copy: BrokerMessage = { exchange, routingKey, redelivered: false, properties: structuredClone(message.properties), content: message.content };
      if (q.consumer) q.consumer(copy, this, { vhost, queue: name });
      else q.messages.push(copy);
    }
    return targets;
  }

  /**
   * The queue's consumer (or a Checkout) rejects `message` without requeue:
   * RabbitMQ 4 records it in `x-death` and the `x-first-death-*` and
   * `x-last-death-*` headers, and publishes it to the queue's dead-letter
   * exchange with its routing key. Dropped when the queue has none.
   */
  reject(ref: QueueRef, message: BrokerMessage, at: Date = new Date()): void {
    const q = this.#required(ref);
    this.#remove(q, message);
    if (!q.deadLetterExchange) return;
    const headers = deadLetterHeaders(message, ref.queue, 'rejected', at);
    this.publish(ref.vhost, q.deadLetterExchange, message.routingKey, { properties: { ...message.properties, headers }, content: message.content });
  }

  /** Holds up to `max` ready Messages from the head of the queue, in order. */
  hold(ref: QueueRef, max: number): BrokerMessage[] {
    const q = this.#required(ref);
    const taken = q.messages.filter((m) => !q.held.has(m)).slice(0, max);
    for (const m of taken) q.held.add(m);
    return taken;
  }

  /** Settles a held Message: it leaves the queue for good. */
  ack(ref: QueueRef, message: BrokerMessage): void {
    this.#remove(this.#required(ref), message);
  }

  /** Returns held Messages to the queue unchanged, where they were (Keep). */
  release(ref: QueueRef, messages: Iterable<BrokerMessage>): void {
    const q = this.#required(ref);
    for (const m of messages) {
      if (q.held.delete(m)) m.redelivered = true;
    }
  }

  #remove(q: Queue, message: BrokerMessage) {
    q.held.delete(message);
    const i = q.messages.indexOf(message);
    if (i >= 0) q.messages.splice(i, 1);
  }

  #required(ref: QueueRef): Queue {
    const q = this.#queues.get(key(ref.vhost, ref.queue));
    if (!q) throw new Error(`No queue "${ref.queue}" in vhost "${ref.vhost}".`);
    return q;
  }

  #route(vhost: string, exchange: string, routingKey: string): string[] {
    if (exchange === '') return this.#queues.has(key(vhost, routingKey)) ? [routingKey] : [];
    const ex = this.#exchanges.get(key(vhost, exchange));
    if (!ex) return [];
    return this.#bindings
      .filter((b) => b.vhost === vhost && b.source === exchange)
      .filter((b) => ex.type === 'fanout' || (ex.type === 'topic' ? topicMatches(b.routingKey, routingKey) : b.routingKey === routingKey))
      .map((b) => b.destination)
      .filter((name) => this.#queues.has(key(vhost, name)));
  }
}

/**
 * The broker of the screenshot scenario as seed.mjs leaves it: every
 * Message published to `orders` or `payments`, rejected by its work queue
 * at `at` and dead-lettered (orders.dlq, payments.dlq and their siblings).
 * The work queues' consumers then process whatever reaches them.
 */
export function scenarioBroker(at: Date): DemoBroker {
  const broker = new DemoBroker(SCENARIO_TOPOLOGY);
  for (const m of scenarioMessages()) {
    broker.publish('/', m.exchange, m.routingKey, { properties: { ...m.properties }, content: m.content });
  }
  for (const queue of ['orders.work', 'payments.work']) {
    const ref = { vhost: '/', queue };
    for (const m of broker.hold(ref, Infinity)) broker.reject(ref, m, at);
    broker.consume(ref, consumes);
  }
  return broker;
}

function deadLetterHeaders(message: BrokerMessage, queue: string, reason: string, at: Date): Record<string, unknown> {
  const headers = { ...message.properties.headers };
  const time: AmqpTimestamp = { '!': 'timestamp', value: Math.floor(at.getTime() / 1000) };
  const earlier = Array.isArray(headers['x-death']) ? (headers['x-death'] as Array<Record<string, unknown>>) : [];
  const same = earlier.find((e) => e.queue === queue && e.reason === reason);
  const entry = same
    ? { ...same, count: Number(same.count ?? 0) + 1 }
    : { count: 1, reason, queue, time, exchange: message.exchange, 'routing-keys': [message.routingKey] };
  headers['x-death'] = [entry, ...earlier.filter((e) => e !== same)];
  headers['x-first-death-exchange'] ??= message.exchange;
  headers['x-first-death-queue'] ??= queue;
  headers['x-first-death-reason'] ??= reason;
  headers['x-last-death-exchange'] = message.exchange;
  headers['x-last-death-queue'] = queue;
  headers['x-last-death-reason'] = reason;
  return headers;
}

/** AMQP topic matching: `*` one word, `#` zero or more. */
function topicMatches(pattern: string, routingKey: string): boolean {
  const match = (p: string[], k: string[]): boolean => {
    if (p.length === 0) return k.length === 0;
    const [head, ...rest] = p;
    if (head === '#') return match(rest, k) || (k.length > 0 && match(p, k.slice(1)));
    if (k.length === 0) return false;
    return (head === '*' || head === k[0]) && match(rest, k.slice(1));
  };
  return match(pattern.split('.'), routingKey.split('.'));
}

function key(vhost: string, name: string): string {
  return `${vhost}\u0000${name}`;
}
