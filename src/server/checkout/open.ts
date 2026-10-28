// Opening a Checkout (ADR 0006): its own AMQP connection, the queue's lock
// queue `volveran.checkout.<queue>` on it (exclusive, auto-delete: one
// Checkout per queue across every Volverán instance, released by the broker
// when the connection dies), the ready count N from a passive declare, and
// the N deliveries collected in windows (collect.ts, capped by the Checkout
// limits) and held unacknowledged in memory, keyed by delivery tag (the
// Message handle).
//
// A closed channel or connection, or a consumer the broker cancels, is
// reported through `onLost`: the broker has returned everything, at the cost
// of one delivery on quorum queues.
import type * as amqp from 'amqplib';
import { openAmqpConnection } from '../amqp-connection.js';
import { brokerPermissionDenied } from '../broker-error.js';
import type { ManagementClient } from '../management.js';
import type { ProfileAccess } from '../profile-access.js';
import type { QueueRef } from '../profiles.js';
import { checkoutSize } from '../triage/checkout-collection.js';
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
    brokerPermissionDenied(
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
      if (checkout.profile.credentials.kind === 'operatorToken') {
        throw brokerPermissionDenied(
          checkout.profile,
          checkout.brokerUser,
          { type: 'queue', name: lockQueue, vhost: checkout.vhost },
          'configure',
          'A Checkout declares its lock queue, so the token needs configure permission on queues matching volveran.* in that vhost.',
        );
      }
      throw lockNotPermitted(checkout);
    }
    throw new CheckoutError('checkout_failed', `Cannot declare the Checkout lock queue "${lockQueue}": ${(err as Error).message}`);
  }
  await channel.close().catch(() => {});
}
