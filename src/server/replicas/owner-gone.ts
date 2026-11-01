// What an Operator is told when the Replica holding their Checkout has gone. Its lease has run
// out, which does not mean the broker has noticed: a killed process's socket drops at once, but
// a lost host's connection stays until the heartbeats fail (docs/rabbitmq-behaviour.md, "Dead
// connections"), and the queue stays locked until then.
import type { CheckoutQueueType } from '../../shared/checkout.js';

export function ownerGoneReason(queueType: CheckoutQueueType): string {
  return (
    'The Replica holding this Checkout has gone: its lease ran out. The broker returns every Message to the queue once it sees the connection gone, at once if the process died and within about 15 seconds if its host or network was lost; the queue stays locked until then' +
    (queueType === 'quorum' ? ', and the return uses up 1 of the Delivery Budget of each Message.' : '.') +
    ' Decisions not yet Applied are gone. If an Apply was running, its Audit Entries say what is known of each Message.'
  );
}

/** On the Replica itself, when it could not renew its lease and so gives its Checkouts up. */
export function ownLeaseRanOutReason(queueType: CheckoutQueueType): string {
  return (
    'This Replica could not renew its lease in the shared store, so the others take it to be gone. It closed its connection to the broker, which returns every Message to the queue' +
    (queueType === 'quorum' ? ', using up 1 of the Delivery Budget of each.' : '.')
  );
}

/** On an Audit Entry left `pending`: a step was begun, and nothing more is known. */
export const INTERRUPTED_REASON =
  'The Replica carrying this out stopped before writing its outcome, so it may or may not have happened. Look in the queue and at the destination.';
