// Pure Delivery Budget calculation (no I/O). On a quorum queue a Message's
// Delivery Budget is the queue's delivery_limit minus its x-delivery-count:
// how many more abnormal returns (a crash, a lost connection, a rejection) it
// survives. Ending a Checkout costs nothing (Keep is basic.nack with requeue),
// but a Lost Checkout costs one, so a Message with 1 left is flagged.
import type { DeliveryBudget } from '../../shared/checkout.js';

export type { DeliveryBudget };

export function deliveryBudget(input: {
  /** `x-delivery-count` (0 when a quorum Message lacks it); null on classic queues, which don't count. */
  deliveryCount: number | null;
  /** The queue's effective delivery_limit; null or negative means unlimited. */
  deliveryLimit: number | null;
  /** Whether the queue has a dead-letter exchange: a Message past the limit is dead-lettered, else dropped. */
  deadLetterExchange: boolean;
}): DeliveryBudget | null {
  const { deliveryCount, deliveryLimit } = input;
  if (deliveryCount === null || deliveryLimit === null || deliveryLimit < 0) return null;
  const remaining = Math.max(0, deliveryLimit - deliveryCount);
  if (remaining > 1) return { remaining, warning: null };
  const fate = input.deadLetterExchange ? 'dead-letters this Message again' : 'drops this Message';
  return { remaining, warning: `Delivery Budget ${remaining}: if this Checkout is lost, the broker ${fate}.` };
}
