// Pure Checkout-lock naming (no I/O). One Checkout per queue (ADR 0006): the
// Checkout's connection declares an exclusive, auto-delete lock queue
// `volveran.checkout.<queue>`. Any other connection, from this or another
// Volverán instance, gets RESOURCE_LOCKED declaring it, and the broker deletes
// it when the holding connection dies. The lock queue's arguments record who
// holds it and since when, so a refused Checkout and the queue list can name
// the holder (read back through the management API).
import { createHash } from 'node:crypto';

const PREFIX = 'volveran.checkout.';
/** RabbitMQ's limit on queue names, in bytes. */
const MAX_QUEUE_NAME_BYTES = 255;

const ARG_QUEUE = 'volveran-queue';
const ARG_OPERATOR = 'volveran-operator';
const ARG_SINCE = 'volveran-started-at';

export interface CheckoutHolder {
  /** The Operator who started the Checkout. */
  operator: string;
  /** ISO time the Checkout started. */
  since: string;
}

/**
 * The lock queue's name. A queue name too long for the prefix is shortened
 * and given a hash of the full name, so it stays unique per queue.
 */
export function lockQueueName(queue: string): string {
  const name = PREFIX + queue;
  if (Buffer.byteLength(name) <= MAX_QUEUE_NAME_BYTES) return name;
  const hash = createHash('sha256').update(queue).digest('hex').slice(0, 16);
  let head = PREFIX + queue;
  const room = MAX_QUEUE_NAME_BYTES - hash.length - 1;
  while (Buffer.byteLength(head) > room) head = head.slice(0, -1);
  return `${head}~${hash}`;
}

export function isLockQueue(name: string): boolean {
  return name.startsWith(PREFIX);
}

/** The arguments the lock queue is declared with. */
export function lockArguments(queue: string, holder: CheckoutHolder): Record<string, string> {
  return { [ARG_QUEUE]: queue, [ARG_OPERATOR]: holder.operator, [ARG_SINCE]: holder.since };
}

/** The checked-out queue and its holder, from a lock queue's arguments; null if they aren't a lock's. */
export function holderFromLockArguments(
  args: Record<string, unknown>,
): { queue: string; holder: CheckoutHolder } | null {
  const queue = args[ARG_QUEUE];
  const operator = args[ARG_OPERATOR];
  const since = args[ARG_SINCE];
  if (typeof queue !== 'string' || typeof operator !== 'string' || typeof since !== 'string') return null;
  return { queue, holder: { operator, since } };
}

/** Queue name → holder, for every Checkout lock queue in a vhost's queue list. */
export function checkoutHolders(queues: Array<{ name: string; arguments: Record<string, unknown> }>): Map<string, CheckoutHolder> {
  const out = new Map<string, CheckoutHolder>();
  for (const q of queues) {
    if (!isLockQueue(q.name)) continue;
    const lock = holderFromLockArguments(q.arguments);
    if (lock) out.set(lock.queue, lock.holder);
  }
  return out;
}

export function describeHolder(holder: CheckoutHolder): string {
  return `${holder.operator} has held it since ${holder.since}`;
}
