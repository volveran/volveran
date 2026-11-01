// Pure (no I/O, no DOM): where the Messages a Checkout gives back end up in
// the queue, worded for the UI after "back in the queue". Classic queues put
// a returned Message back in its original position; quorum queues put
// returned Messages ahead of newer ones, behind any returned before them, and
// on a large Checkout do not keep their order (docs/rabbitmq-behaviour.md
// "Order after a return").
import type { CheckoutQueueType } from './checkout.js';

export function returnOrder(queueType: CheckoutQueueType): string {
  return queueType === 'classic'
    ? 'in their original positions'
    : 'ahead of newer Messages but behind any returned earlier, in their original order unless the Checkout was large';
}
