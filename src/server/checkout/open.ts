// Opening a Checkout (ADR 0006): its own AMQP connection, the queue's lock
// queue `volveran.checkout.<queue>` on it (exclusive, auto-delete: one
// Checkout per queue across every Volverán instance, released by the broker
// when the connection dies), the ready count N from a passive declare, and
// the N deliveries collected in windows (collect.ts, capped by the Checkout
// limits) and held unacknowledged in memory, keyed by delivery tag (the
// Message handle).
//
// Once the Messages are held, where each would be watched as a Canary is
// looked up from the management API (triage/canary-watch.ts), so the Apply
// confirmation can say beforehand when a Canary would be unwatched.
//
// A closed channel or connection, or a consumer the broker cancels, is
// reported through `onLost`: the broker has returned everything, at the cost
// of one delivery on quorum queues.
import type * as amqp from 'amqplib';
import { openAmqpConnection } from '../amqp-connection.js';
import { permissionRefused } from '../broker-credentials.js';
import type { ManagementClient } from '../management.js';
import type { ProfileAccess } from '../profile-access.js';
import type { QueueRef } from '../profiles.js';
import { canaryWatchBindings, type CanaryWatchBindings } from '../triage/canary-watch.js';
import { checkoutSize } from '../triage/checkout-collection.js';
import { replayOrigin } from '../triage/replay-origin.js';
import type { VhostTopology } from '../triage/setup-checks.js';
import { consumerTimeoutMs } from '../triage/checkout-timing.js';
import { holderFromLockArguments, lockArguments, lockQueueName } from '../triage/checkout-lock.js';
import { isCheckoutQueueType, notCheckoutableReason } from '../triage/queue-list.js';
import { collect } from './collect.js';
import { CheckoutError, hasConsumers, inCheckout, lockNotPermitted, queueNotFound } from './errors.js';
import type { Checkout } from './state.js';

/** The AMQP connection name of a Checkout, so the broker's connection list shows what it is for. */
export function checkoutConnectionName(vhost: string, queue: string): string {
  return `volveran checkout ${vhost} ${queue}`;
}

export interface StartOptions {
  /** Start even though other consumers read the queue (the Operator overrode the live-consumer warning). */
  overrideConsumers?: boolean;
}

export interface OpenHooks {
  /** Marks the Checkout lost with this reason (and releases it); a no-op once it is over. */
  onLost(reason: string): void;
  /** Test seam: the lock is held; next the ready count is read. */
  afterLock?(ref: QueueRef): Promise<void>;
  /** Test seam: collection stopped waiting; next the consumer is cancelled. */
  afterCollectWait?(ref: QueueRef): Promise<void>;
  /** Test seam: the Messages are collected (the window sizes, and how many deliveries overflowed). */
  afterCollect?(ref: QueueRef, collected: { windows: number[]; overflow: number }): Promise<void>;
}

/**
 * Fills in `checkout` (queue facts, broker user, connection, channel, held
 * Messages); `access` is its Broker Profile's management client and the
 * Operator's broker credentials, from the access check. On a throw the
 * caller closes `checkout.connection`, which releases the lock.
 *
 * The connection opens with the Operator's credentials, so on a profile with
 * `credentials: operatorToken` the broker checks their own permissions: a
 * refused read of the queue answers 403 `broker_permission_denied`.
 */
export async function openCheckout(
  checkout: Checkout,
  access: Pick<ProfileAccess, 'management' | 'credentials'>,
  options: StartOptions,
  hooks: OpenHooks,
): Promise<void> {
  const { vhost, queue } = checkout;
  const { management } = access;
  const info = await management.getQueue(vhost, queue);
  if (!info) throw queueNotFound(checkout);
  if (!isCheckoutQueueType(info.type)) throw new CheckoutError('queue_not_checkoutable', notCheckoutableReason(info.type));
  checkout.queueType = info.type;
  checkout.deliveryLimit = info.deliveryLimit;
  checkout.deadLetterExchange =
    typeof info.arguments['x-dead-letter-exchange'] === 'string' ||
    typeof info.effectivePolicy['dead-letter-exchange'] === 'string';

  const credentials = access.credentials();
  checkout.brokerUser = credentials.brokerUser;
  const connection = await openAmqpConnection(checkout.profile, credentials, vhost, checkoutConnectionName(vhost, queue));
  checkout.connection = connection;
  connection.on('close', (err?: Error) =>
    hooks.onLost(
      `The connection to the broker was closed${err ? ` (${err.message})` : ''}. The broker has returned every Message to the queue` +
        (checkout.queueType === 'quorum' ? ', which used up 1 of the Delivery Budget of each.' : '.'),
    ),
  );

  await takeLock(checkout, connection, management);
  await hooks.afterLock?.(checkout);

  const channel = await connection.createChannel();
  checkout.channel = channel;
  // A quorum queue's consumer timeout arrives as a channel close once the
  // consumer is cancelled (ADR 0006); the Messages are back in order. A
  // channel closed with its connection has no error of its own: the
  // connection's close reports that.
  // A refused read (403 ACCESS_REFUSED) closes the channel the same way; it
  // arrives before the refused call fails, so the start reports it instead.
  let readRefused = false;
  channel.on('error', (err: Error & { code?: number }) => {
    if (err.code === 403) readRefused = true;
    hooks.onLost(`The broker closed the channel holding the Messages (${err.message}). Every Message is back in the queue.`);
  });
  const readDenied = () =>
    permissionRefused(
      checkout.profile,
      checkout.brokerUser,
      { type: 'queue', name: queue, vhost },
      'read',
      'A Checkout consumes the queue, so it needs read permission on it.',
    );

  let ready: number;
  let consumers: number;
  try {
    ({ messageCount: ready, consumerCount: consumers } = await channel.checkQueue(queue));
  } catch (err) {
    const code = (err as { code?: number }).code;
    if (code === 404) throw queueNotFound(checkout);
    if (code === 403) throw readDenied();
    throw err;
  }
  // Exact, unlike the management API's count; the lock queue is not a consumer of the queue.
  if (consumers > 0 && !options.overrideConsumers) throw hasConsumers(checkout, consumers);
  checkout.onlyConsumer = consumers === 0;
  checkout.readyAtStart = ready;
  const { take, limitedBy } = checkoutSize({ ready, maxMessages: checkout.limits.maxMessages });
  checkout.limitedBy = limitedBy;
  if (take === 0) return;

  const lost = () =>
    readRefused ? readDenied() : new CheckoutError('checkout_failed', checkout.lostReason ?? 'The Checkout was lost.');
  let collected;
  try {
    collected = await collect(channel, queue, {
      expected: take,
      maxBytes: checkout.limits.maxBytes,
      consumerTimeoutMs: checkout.queueType === 'quorum' ? consumerTimeoutMs(checkout.timing) : undefined,
      active: () => checkout.status === 'active',
      afterWait: hooks.afterCollectWait && (() => hooks.afterCollectWait!(checkout)),
      onBrokerCancel: () => hooks.onLost('The broker cancelled the Checkout consumer. Every Message is back in the queue.'),
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
  await hooks.afterCollect?.(checkout, { windows: collected.windows, overflow: collected.overflow.length });
  checkout.canaryWatch = await lookUpCanaryWatch(checkout, management);
}

/** Source queues looked up at most, for the Messages' Canary watch; Messages from others are unwatched. */
const MAX_CANARY_SOURCES = 20;

/**
 * How each held Message would be watched as the Canary: its source queue's
 * dead-letter exchange (or, Replayed to a MassTransit input queue, its
 * `_error` exchange) and that exchange's bindings to the Checkout's queue.
 * Never throws: a topology it cannot read leaves the Messages unwatched,
 * with the reason.
 */
async function lookUpCanaryWatch(checkout: Checkout, management: ManagementClient): Promise<Map<number, CanaryWatchBindings>> {
  // Keyed by the origin: the same queue can be reached through x-death and as a MassTransit input queue.
  const sourceOf = new Map<number, { queue: string; via: 'x-death' | 'masstransit'; key: string }>();
  for (const [handle, m] of checkout.held) {
    const origin = replayOrigin(m.properties.headers);
    if (origin.ok) sourceOf.set(handle, { queue: origin.queue, via: origin.via, key: `${origin.via}:${origin.queue}` });
  }
  const result = new Map<number, CanaryWatchBindings>();
  if (sourceOf.size === 0) return result;
  const sources = [...new Set([...sourceOf.values()].map((s) => s.queue))].slice(0, MAX_CANARY_SOURCES);
  let topology: VhostTopology;
  let queues: Map<string, Awaited<ReturnType<ManagementClient['getQueue']>>>;
  try {
    const [exchanges, bindings, found] = await Promise.all([
      management.listExchanges(checkout.vhost),
      management.listBindings(checkout.vhost),
      Promise.all(sources.map((q) => management.getQueue(checkout.vhost, q))),
    ]);
    topology = { exchanges: new Map(exchanges.map((e) => [e.name, e])), bindings };
    queues = new Map(sources.map((q, i) => [q, found[i]!]));
  } catch (err) {
    const reason = `Could not read where the Messages dead-letter from the management API (${(err as Error).message}). The Canary's outcome will only say whether it was Replayed.`;
    for (const handle of sourceOf.keys()) result.set(handle, { watchable: false, reason });
    return result;
  }
  const bySource = new Map<string, CanaryWatchBindings>();
  for (const [handle, { queue, via, key }] of sourceOf) {
    let bindings = bySource.get(key);
    if (!bindings) {
      const info = queues.get(queue);
      bindings = canaryWatchBindings({
        source: info ? { name: queue, arguments: info.arguments, effectivePolicy: info.effectivePolicy } : null,
        ...(via === 'masstransit' && { massTransitInputQueue: queue }),
        deadLetterQueue: checkout.queue,
        topology,
      });
      bySource.set(key, bindings);
    }
    result.set(handle, bindings);
  }
  return result;
}

/**
 * Declares the queue's lock queue on the Checkout's connection, on a
 * channel of its own (a refused declare closes the channel). Another
 * connection holding it gives RESOURCE_LOCKED; its arguments name the holder.
 */
async function takeLock(checkout: Checkout, connection: amqp.ChannelModel, management: ManagementClient): Promise<void> {
  const lockQueue = lockQueueName(checkout.queue);
  const channel = await connection.createChannel();
  channel.on('error', () => {});
  try {
    await channel.assertQueue(lockQueue, {
      exclusive: true,
      autoDelete: true,
      durable: false,
      arguments: lockArguments(
        checkout.queue,
        { operator: checkout.operator.displayName, since: checkout.startedAt.toISOString() },
        checkout.operator.id,
      ),
    });
  } catch (err) {
    const code = (err as { code?: number }).code;
    if (code === 405) {
      const lock = await management.getQueue(checkout.vhost, lockQueue).catch(() => null);
      throw inCheckout(checkout, lock ? (holderFromLockArguments(lock.arguments)?.holder ?? null) : null);
    }
    if (code === 403) {
      throw permissionRefused(
        checkout.profile,
        checkout.brokerUser,
        { type: 'queue', name: lockQueue, vhost: checkout.vhost },
        'configure',
        'A Checkout declares its lock queue, so the token needs configure permission on queues matching volveran.* in that vhost.',
        lockNotPermitted(checkout),
      );
    }
    throw new CheckoutError('checkout_failed', `Cannot declare the Checkout lock queue "${lockQueue}": ${(err as Error).message}`);
  }
  await channel.close().catch(() => {});
}

/** The longest an end waits for the broker to stop counting its consumers; they have cleared within 200 ms on a starved broker. */
const OWN_CONSUMERS_GONE_MS = 3_000;
const OWN_CONSUMERS_POLL_MS = 20;

/**
 * Waits until a passive declare counts no consumer of a queue the Checkout was
 * alone on. A quorum queue can go on counting the consumers of a channel after
 * its close has answered (measured with 200 Messages on a broker at 0.25 CPU: 7
 * ends in 120, clearing within 100 ms; too rare to pin as a broker fact), and the
 * next start would refuse with `queue_has_consumers`. Anyone who began
 * consuming meanwhile only costs this wait, as does a queue that has gone.
 */
async function ownConsumersGone(connection: amqp.ChannelModel, queue: string): Promise<void> {
  try {
    const channel = await connection.createChannel();
    channel.on('error', () => {});
    const deadline = Date.now() + OWN_CONSUMERS_GONE_MS;
    while ((await channel.checkQueue(queue)).consumerCount > 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, OWN_CONSUMERS_POLL_MS));
    }
    await channel.close();
  } catch {
    // The queue or the connection is gone: there is nothing to wait for.
  }
}

/**
 * Closes the Checkout's connection, deleting its lock queue first. The broker
 * deletes an exclusive queue only some time after answering the connection's
 * close (docs/rabbitmq-behaviour.md, "Watch queue lifetime"), so a close alone
 * would leave the queue refusing the next Checkout. A connection that does not
 * own the lock is refused the delete, and it stays with its holder.
 */
export async function closeCheckoutConnection(checkout: Checkout): Promise<void> {
  const { connection } = checkout;
  if (!connection) return;
  // Before the lock goes: while it is held, no start can read the count.
  if (checkout.onlyConsumer) await ownConsumersGone(connection, checkout.queue);
  try {
    const channel = await connection.createChannel();
    channel.on('error', () => {});
    await channel.deleteQueue(lockQueueName(checkout.queue));
  } catch {
    // The connection is going anyway: the broker deletes the lock queue with it.
  }
  await connection.close().catch(() => {});
}
