// What an Operator reads when the Replica holding their Checkout shut down. It may come from
// another Replica, which knows no more than the record: so it speaks of an Apply as a possibility.
import { product } from '../shared/product.js';
import { returnOrder } from '../shared/return-order.js';
import type { CheckoutQueueType } from '../shared/checkout.js';

export function shutdownLine(queueType: CheckoutQueueType): string {
  return `This Checkout ended because the ${product.name} Replica holding it shut down; its Messages are back in the queue ${returnOrder(queueType)}. If an Apply was running, it stopped before its next step, and the Audit Entries say what was done. You can start another Checkout.`;
}
