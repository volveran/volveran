// Checkout manager (ADR 0006): the lifecycle of every Checkout. A Checkout
// opens its own AMQP connection, takes the queue's lock queue
// `volveran.checkout.<queue>` on it (exclusive, auto-delete: one Checkout per
// queue across every Volverán instance, released by the broker when the
// connection dies), reads the ready count N with a passive declare, collects
// those N deliveries (collect.ts, capped by the Checkout limits) and holds
// them unacknowledged in memory, keyed by delivery tag (the Message handle).
//
// Ending a Checkout nack-requeues every held Message one at a time in queue
// order, then the overflow, before closing the channel: on quorum queues that
// costs no Delivery Budget and keeps the order. A closed channel or
// connection (a crash, the network, a quorum consumer timeout arriving as a
// channel close) makes it a Lost Checkout: the broker has returned
// everything, at the cost of one delivery on quorum queues.
//
// A Checkout never holds Messages forever: it ends itself at its time limit,
// and when the browser has sent no heartbeat for the heartbeat window
// (checkout-timing.ts). On quorum queues its consumer carries
// `x-consumer-timeout` a margin past the time limit, as a backstop.
//
// In-process, an Operator (keyed by `Operator.id`) has at most one active Checkout, and a queue at
// most one (checked before the broker's lock, so the holder is known exactly).
import { randomUUID } from 'node:crypto';
import type * as amqp from 'amqplib';
import { openAmqpConnection } from '../amqp-connection.js';
import { ManagementClient } from '../management.js';
import type { Operator } from '../operator.js';
import type { QueueRef } from '../profiles.js';
import { checkoutSize, type CheckoutLimits } from '../triage/checkout-collection.js';
import { consumerTimeoutMs, DEFAULT_CHECKOUT_TIMING, type CheckoutTiming } from '../triage/checkout-timing.js';
import { holderFromLockArguments, lockArguments, lockQueueName } from '../triage/checkout-lock.js';
import { messageDetail, type MessageDetail } from '../triage/message-view.js';
import { isCheckoutQueueType, notCheckoutableReason } from '../triage/queue-list.js';
import { collect } from './collect.js';
import { CheckoutError, hasConsumers, inCheckout, lockNotPermitted, operatorHasCheckout, queueNotFound } from './errors.js';
import type { Checkout, EndReason } from './state.js';
import { queueInfo, view, type CheckoutView } from './view.js';

/**
 * Test seams: awaited where a race with the broker or another request
 * decides the outcome, so a test can act there deterministically.
 */
export interface CheckoutTestHooks {
  /** A start holds the queue's lock queue; next it reads the ready count and collects. */
  afterLock?(ref: { vhost: string; queue: string }): Promise<void>;
  /** A start has stopped waiting for deliveries; next it cancels its consumer. */
  afterCollectWait?(ref: { vhost: string; queue: string }): Promise<void>;
  /** A Checkout reached its time limit; next it ends itself. */
  beforeTimeLimitEnd?(ref: { vhost: string; queue: string }): Promise<void>;
}

export interface CheckoutManagerOptions {
  limits: CheckoutLimits;
  /** Time limit, heartbeat window and quorum backstop margin (default DEFAULT_CHECKOUT_TIMING). */
  timing?: CheckoutTiming;
  /** How long an ended or lost Checkout stays readable before it is forgotten. */
  endedRetentionMs?: number;
  testHooks?: CheckoutTestHooks;
}

const DEFAULT_ENDED_RETENTION_MS = 15 * 60_000;

/** The AMQP connection name of a Checkout, so the broker's connection list shows what it is for. */
export function checkoutConnectionName(vhost: string, queue: string): string {
  return `volveran checkout ${vhost} ${queue}`;
}

export interface StartOptions {
  /** Start even though other consumers read the queue (the Operator overrode the live-consumer warning). */
  overrideConsumers?: boolean;
}

export class CheckoutManager {
  private readonly checkouts = new Map<string, Checkout>();
  /** Lock key (broker + vhost + queue) → the Checkout holding it, from the moment it starts. */
  private readonly locks = new Map<string, Checkout>();
  /** Operator id → their Checkout, from the moment it starts until it is over. */
  private readonly byOperator = new Map<string, Checkout>();
  private readonly hooks: CheckoutTestHooks;
  private readonly endedRetentionMs: number;
  private readonly timing: CheckoutTiming;

  constructor(private readonly options: CheckoutManagerOptions) {
    this.hooks = options.testHooks ?? {};
    this.timing = options.timing ?? DEFAULT_CHECKOUT_TIMING;
    this.endedRetentionMs = options.endedRetentionMs ?? DEFAULT_ENDED_RETENTION_MS;
  }

  async start(ref: QueueRef, operator: Operator, options: StartOptions = {}): Promise<CheckoutView> {
    const mine = this.byOperator.get(operator.id);
    if (mine) throw operatorHasCheckout(operator.displayName, mine);
    const lockKey = this.lockKey(ref);
    const other = this.locks.get(lockKey);
    if (other) throw inCheckout(ref, { operator: other.operator.displayName, since: other.startedAt.toISOString() });

    const startedAt = new Date();
    const checkout: Checkout = {
      ...ref,
      id: randomUUID(),
      operator,
      queueType: 'classic',
      deliveryLimit: null,
      deadLetterExchange: false,
      startedAt,
      timing: this.timing,
      expiresAt: new Date(startedAt.getTime() + this.timing.timeLimitMs),
      timeLimitTimer: undefined,
      heartbeatTimer: undefined,
      status: 'active',
      lostReason: null,
      endReason: null,
      readyAtStart: 0,
      limits: this.options.limits,
      limitedBy: null,
      connection: undefined,
      channel: undefined,
      held: new Map(),
      overflow: [],
      heldBytes: 0,
      decisions: new Map(),
    };
    this.locks.set(lockKey, checkout);
    this.byOperator.set(operator.id, checkout);
    try {
      await this.open(checkout, options);
    } catch (err) {
      this.release(checkout);
      await checkout.connection?.close().catch(() => {});
      throw err;
    }
    this.checkouts.set(checkout.id, checkout);
    if (checkout.status === 'active') this.startTimers(checkout);
    return view(checkout);
  }

  /** The browser still shows the Checkout: it stays until the next heartbeat window passes. */
  heartbeat(id: string): CheckoutView {
    const checkout = this.find(id);
    if (checkout.status === 'active') checkout.heartbeatTimer?.refresh();
    return view(checkout);
  }

  get(id: string): CheckoutView {
    return view(this.find(id));
  }

  /** The Checkout itself, for the modules that work on its held Messages (staging.ts). */
  checkout(id: string): Checkout {
    return this.find(id);
  }

  /** The active Checkout of the Operator with this id, if any. */
  activeFor(operatorId: string): CheckoutView | null {
    const c = this.byOperator.get(operatorId);
    return c && this.checkouts.has(c.id) ? view(c) : null;
  }

  message(id: string, handle: number): MessageDetail {
    const checkout = this.find(id);
    const m = checkout.held.get(handle);
    if (!m) throw new CheckoutError('message_not_found', `Checkout ${id} holds no Message with handle ${handle}.`);
    return messageDetail(handle, m, queueInfo(checkout));
  }

  /** Ends the Checkout: every held Message goes back to the queue untouched, in its original order. */
  async end(id: string, reason: EndReason = 'operator'): Promise<CheckoutView> {
    const checkout = this.find(id);
    if (checkout.status !== 'active') return view(checkout);
    checkout.status = 'ended';
    checkout.endReason = reason;
    const { channel, connection } = checkout;
    try {
      if (channel) {
        // Keep = basic.nack(requeue), one at a time in queue order: unlike
        // reject or closing with unacked deliveries it uses up no Delivery
        // Budget, and a quorum queue puts them back in the order returned.
        for (const m of checkout.held.values()) channel.nack(m, false, true);
        for (const m of checkout.overflow) channel.nack(m, false, true);
        await channel.close();
      }
    } catch {
      // The channel is already gone: the broker has returned everything.
    }
    // Closing the connection deletes the lock queue: the queue is free again.
    await connection?.close().catch(() => {});
    checkout.held.clear();
    checkout.overflow = [];
    this.release(checkout);
    return view(checkout);
  }

  /** Ends every active Checkout (on shutdown). */
  async endAll(): Promise<void> {
    const active = [...this.checkouts.values()].filter((c) => c.status === 'active');
    await Promise.all(active.map((c) => this.end(c.id, 'shutdown')));
  }

  private lockKey(ref: QueueRef): string {
    return JSON.stringify([ref.profile.amqpUrl, ref.vhost, ref.queue]);
  }

  private find(id: string): Checkout {
    const checkout = this.checkouts.get(id);
    if (!checkout) throw new CheckoutError('checkout_not_found', `No Checkout with id "${id}".`);
    return checkout;
  }

  /** The Checkout is over (or never started): frees its queue and its Operator, and forgets it after a while. */
  private release(checkout: Checkout) {
    const lockKey = this.lockKey(checkout);
    if (this.locks.get(lockKey) === checkout) this.locks.delete(lockKey);
    if (this.byOperator.get(checkout.operator.id) === checkout) this.byOperator.delete(checkout.operator.id);
    clearTimeout(checkout.timeLimitTimer);
    clearTimeout(checkout.heartbeatTimer);
    setTimeout(() => this.checkouts.delete(checkout.id), this.endedRetentionMs).unref();
  }

  private startTimers(checkout: Checkout) {
    const left = checkout.expiresAt.getTime() - Date.now();
    checkout.timeLimitTimer = setTimeout(async () => {
      await this.hooks.beforeTimeLimitEnd?.(checkout);
      await this.end(checkout.id, 'time-limit').catch(() => {});
    }, Math.max(0, left));
    checkout.heartbeatTimer = setTimeout(
      () => this.end(checkout.id, 'no-heartbeat').catch(() => {}),
      checkout.timing.heartbeatWindowMs,
    );
    checkout.timeLimitTimer.unref();
    checkout.heartbeatTimer.unref();
  }

  private markLost(checkout: Checkout, reason: string) {
    if (checkout.status !== 'active') return;
    checkout.status = 'lost';
    checkout.lostReason = reason;
    checkout.held.clear();
    checkout.overflow = [];
    this.release(checkout);
    checkout.connection?.close().catch(() => {});
  }

  private async open(checkout: Checkout, options: StartOptions): Promise<void> {
    const { vhost, queue } = checkout;
    const management = new ManagementClient(checkout.profile);
    const info = await management.getQueue(vhost, queue);
    if (!info) throw queueNotFound(checkout);
    if (!isCheckoutQueueType(info.type)) throw new CheckoutError('queue_not_checkoutable', notCheckoutableReason(info.type));
    checkout.queueType = info.type;
    checkout.deliveryLimit = info.deliveryLimit;
    checkout.deadLetterExchange =
      typeof info.arguments['x-dead-letter-exchange'] === 'string' ||
      typeof info.effectivePolicy['dead-letter-exchange'] === 'string';

    const connection = await openAmqpConnection(checkout.profile, vhost, checkoutConnectionName(vhost, queue));
    checkout.connection = connection;
    connection.on('close', (err?: Error) =>
      this.markLost(
        checkout,
        `The connection to the broker was closed${err ? ` (${err.message})` : ''}. The broker has returned every Message to the queue` +
          (checkout.queueType === 'quorum' ? ', which used up 1 of the Delivery Budget of each.' : '.'),
      ),
    );

    await this.takeLock(checkout, connection, management);
    await this.hooks.afterLock?.(checkout);

    const channel = await connection.createChannel();
    checkout.channel = channel;
    // A quorum queue's consumer timeout arrives as a channel close once the
    // consumer is cancelled (ADR 0006); the Messages are back in order. A
    // channel closed with its connection has no error of its own: the
    // connection's close reports that.
    channel.on('error', (err: Error) =>
      this.markLost(
        checkout,
        `The broker closed the channel holding the Messages (${err.message}). Every Message is back in the queue.`,
      ),
    );

    let ready: number;
    let consumers: number;
    try {
      ({ messageCount: ready, consumerCount: consumers } = await channel.checkQueue(queue));
    } catch (err) {
      if ((err as { code?: number }).code === 404) throw queueNotFound(checkout);
      throw err;
    }
    // Exact, unlike the management API's count; the lock queue is not a consumer of the queue.
    if (consumers > 0 && !options.overrideConsumers) throw hasConsumers(checkout, consumers);
    checkout.readyAtStart = ready;
    const { take, limitedBy } = checkoutSize({
      ready,
      readyBytes: info.messageBytesReady,
      ...checkout.limits,
    });
    checkout.limitedBy = limitedBy;
    if (take === 0) return;

    const lost = () => new CheckoutError('checkout_failed', checkout.lostReason ?? 'The Checkout was lost.');
    let collected;
    try {
      collected = await collect(channel, queue, {
        expected: take,
        maxBytes: checkout.limits.maxBytes,
        consumerTimeoutMs: checkout.queueType === 'quorum' ? consumerTimeoutMs(checkout.timing) : undefined,
        active: () => checkout.status === 'active',
        afterWait: this.hooks.afterCollectWait && (() => this.hooks.afterCollectWait!(checkout)),
        onBrokerCancel: () =>
          this.markLost(checkout, 'The broker cancelled the Checkout consumer. Every Message is back in the queue.'),
      });
    } catch (err) {
      // A cancel or nack on a closed channel fails with a plain error; the cause is the lost Checkout.
      throw checkout.status === 'active' ? err : lost();
    }
    if (checkout.status !== 'active') throw lost();
    checkout.held = new Map(collected.held.map((m) => [m.fields.deliveryTag, m]));
    checkout.overflow = collected.overflow;
    checkout.heldBytes = collected.heldBytes;
    if (collected.overflow.length > 0) checkout.limitedBy = 'bytes';
  }

  /**
   * Declares the queue's lock queue on the Checkout's connection, on a
   * channel of its own (a refused declare closes the channel). Another
   * connection holding it gives RESOURCE_LOCKED; its arguments name the holder.
   */
  private async takeLock(checkout: Checkout, connection: amqp.ChannelModel, management: ManagementClient) {
    const lockQueue = lockQueueName(checkout.queue);
    const channel = await connection.createChannel();
    channel.on('error', () => {});
    try {
      await channel.assertQueue(lockQueue, {
        exclusive: true,
        autoDelete: true,
        durable: false,
        arguments: lockArguments(checkout.queue, { operator: checkout.operator.displayName, since: checkout.startedAt.toISOString() }),
      });
    } catch (err) {
      const code = (err as { code?: number }).code;
      if (code === 405) {
        const lock = await management.getQueue(checkout.vhost, lockQueue).catch(() => null);
        throw inCheckout(checkout, lock ? (holderFromLockArguments(lock.arguments)?.holder ?? null) : null);
      }
      if (code === 403) throw lockNotPermitted(checkout);
      throw new CheckoutError(
        'checkout_failed',
        `Cannot declare the Checkout lock queue "${lockQueue}": ${(err as Error).message}`,
      );
    }
    await channel.close().catch(() => {});
  }
}
