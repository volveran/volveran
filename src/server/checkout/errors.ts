// Errors from starting, using and ending a Checkout. Every message names the
// queue and says what the Operator can do about it.
import { HttpError } from '../http-error.js';
import type { QueueRef } from '../profiles.js';
import { describeHolder, type CheckoutHolder } from '../triage/checkout-lock.js';

export type CheckoutErrorCode =
  | 'queue_not_found'
  | 'queue_not_checkoutable'
  | 'checkout_in_progress'
  | 'operator_has_checkout'
  | 'queue_has_consumers'
  | 'lock_not_permitted'
  | 'checkout_not_found'
  | 'checkout_not_active'
  | 'message_not_found'
  | 'decision_not_allowed'
  | 'checkout_failed';

const STATUS: Record<CheckoutErrorCode, number> = {
  queue_not_found: 404,
  queue_not_checkoutable: 409,
  checkout_in_progress: 409,
  operator_has_checkout: 409,
  queue_has_consumers: 409,
  lock_not_permitted: 403,
  checkout_not_found: 404,
  checkout_not_active: 409,
  message_not_found: 404,
  decision_not_allowed: 422,
  checkout_failed: 502,
};

export class CheckoutError extends HttpError<CheckoutErrorCode> {
  constructor(code: CheckoutErrorCode, message: string, details: Record<string, unknown> = {}) {
    super(STATUS[code], code, message, details);
    this.name = 'CheckoutError';
  }
}

type Queue = Pick<QueueRef, 'vhost' | 'queue'>;

/** The queue is already in a Checkout; `holder` is null when the broker would not say whose. */
export function inCheckout({ vhost, queue }: Queue, holder: CheckoutHolder | null): CheckoutError {
  const who = holder ? `: ${describeHolder(holder)}` : ' from another Volverán instance';
  return new CheckoutError(
    'checkout_in_progress',
    `Queue "${queue}" in vhost "${vhost}" is already checked out${who}. Only one Checkout per queue can exist at a time; try again once it has ended.`,
    { holder },
  );
}

export function operatorHasCheckout(operator: string, other: Queue & { id: string }): CheckoutError {
  return new CheckoutError(
    'operator_has_checkout',
    `${operator} already has an active Checkout of queue "${other.queue}" in vhost "${other.vhost}". End it before starting another.`,
    { checkoutId: other.id, vhost: other.vhost, queue: other.queue },
  );
}

/** Other consumers read the queue (count from a passive declare); the Operator may override. */
export function hasConsumers({ vhost, queue }: Queue, consumers: number): CheckoutError {
  const n = consumers === 1 ? '1 consumer is' : `${consumers} consumers are`;
  return new CheckoutError(
    'queue_has_consumers',
    `${n} reading queue "${queue}" in vhost "${vhost}". A Checkout would compete with them for Messages, and they keep receiving the ones the Checkout does not hold. Stop them first, or start the Checkout with the consumer override to go ahead anyway.`,
    { consumers },
  );
}

export function lockNotPermitted({ profile, vhost, queue }: QueueRef): CheckoutError {
  return new CheckoutError(
    'lock_not_permitted',
    `Broker user "${profile.username}" of Broker Profile "${profile.name}" may not declare the Checkout lock queue for "${queue}" in vhost "${vhost}". ` +
      `A Checkout needs configure permission on queues matching ^volveran\\. in that vhost; grant it, e.g. a configure pattern of "^volveran\\." (or wider).`,
  );
}

export function queueNotFound({ vhost, queue }: Queue): CheckoutError {
  return new CheckoutError('queue_not_found', `Queue "${queue}" does not exist in vhost "${vhost}".`);
}
