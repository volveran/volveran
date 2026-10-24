// Checking a Move destination against the broker when the Decision is given
// (management API): it must be an existing queue or exchange in the
// Checkout's vhost. Apply checks again for free: a destination deleted since
// makes the publish fail, and the Message falls back to Keep.
import type { MoveDestination } from '../../shared/decisions.js';
import { ManagementClient } from '../management.js';
import type { QueueRef } from '../profiles.js';
import { isLockQueue } from '../triage/checkout-lock.js';
import { CheckoutError } from './errors.js';

/** Throws `decision_not_allowed` when `destination` is not an existing queue or exchange of `checkout`'s vhost. */
export async function assertMoveDestinationExists(checkout: QueueRef, destination: MoveDestination): Promise<void> {
  const client = new ManagementClient(checkout.profile);
  const { vhost } = checkout;
  if ('queue' in destination) {
    const queue = isLockQueue(destination.queue) ? null : await client.getQueue(vhost, destination.queue);
    if (!queue) {
      throw new CheckoutError(
        'decision_not_allowed',
        `There is no queue "${destination.queue}" in vhost "${vhost}": a Move can only go to an existing queue of the same vhost.`,
      );
    }
    return;
  }
  const exchange = await client.getExchange(vhost, destination.exchange);
  if (!exchange) {
    throw new CheckoutError(
      'decision_not_allowed',
      `There is no exchange "${destination.exchange}" in vhost "${vhost}": a Move can only go to an existing exchange of the same vhost.`,
    );
  }
  if (exchange.internal) {
    throw new CheckoutError(
      'decision_not_allowed',
      `Exchange "${destination.exchange}" in vhost "${vhost}" is internal, so nothing can be published to it: pick another exchange or a queue.`,
    );
  }
}
