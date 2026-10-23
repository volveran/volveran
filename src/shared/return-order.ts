// Pure (no I/O, no DOM): where the Messages a Checkout gives back end up in
// the queue, worded for the UI after "back in the queue". Classic queues put
// a returned Message back in its original position; quorum queues put
// returned Messages ahead of newer ones in the order returned, so behind any
// Messages returned before them (docs/rabbitmq-behaviour.md "Order after a
// return").

export function returnOrder(queueType: 'classic' | 'quorum'): string {
  return queueType === 'classic'
    ? 'in their original positions'
    : 'in their original order, ahead of newer Messages but behind any returned earlier';
}
