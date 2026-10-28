// Errors from starting, using and ending a Checkout. Every message names the
// queue and says what the Operator can do about it.
import { HttpError } from '../http-error.js';
import type { QueueRef } from '../profiles.js';
import { describeHolder, type CheckoutHolder } from '../triage/checkout-lock.js';
import type { CheckoutState } from './state.js';

export type CheckoutErrorCode =
  | 'queue_not_found'
  | 'queue_not_checkoutable'
  | 'checkout_in_progress'
  | 'operator_has_checkout'
  | 'queue_has_consumers'
  | 'lock_not_permitted'
  | 'checkout_not_found'
  | 'not_checkout_owner'
  | 'checkout_not_active'
  | 'apply_in_progress'
  | 'message_not_found'
  | 'decision_not_allowed'
  | 'checkout_failed'
  | 'approval_required'
  | 'approval_not_required'
  | 'awaiting_approval'
  | 'not_awaiting_approval'
  | 'cannot_approve_own_apply';

const STATUS: Record<CheckoutErrorCode, number> = {
  queue_not_found: 404,
  queue_not_checkoutable: 409,
  checkout_in_progress: 409,
  operator_has_checkout: 409,
  queue_has_consumers: 409,
  lock_not_permitted: 403,
  checkout_not_found: 404,
  not_checkout_owner: 403,
  checkout_not_active: 409,
  apply_in_progress: 409,
  message_not_found: 404,
  decision_not_allowed: 422,
  checkout_failed: 502,
  approval_required: 409,
  approval_not_required: 409,
  awaiting_approval: 409,
  not_awaiting_approval: 409,
  cannot_approve_own_apply: 403,
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

/** Another Operator's Checkout: says nothing of what it holds. */
export function notCheckoutOwner(id: string): CheckoutError {
  return new CheckoutError(
    'not_checkout_owner',
    `Checkout ${id} belongs to another Operator. Only the Operator who started a Checkout can see or use it.`,
  );
}

/**
 * The Checkout is over or lost, so `consequence` (e.g. "nothing can be
 * Applied") holds. A Lost Checkout's message says why it was lost.
 */
export function checkoutNotActive(
  checkout: Queue & { status: CheckoutState; lostReason: string | null },
  consequence: string,
): CheckoutError {
  const which = `The Checkout of "${checkout.queue}" in vhost "${checkout.vhost}"`;
  const state =
    checkout.status === 'lost'
      ? `${which} was lost${checkout.lostReason ? `: ${checkout.lostReason}` : '.'}`
      : `${which} is over: its Messages are back in the queue.`;
  return new CheckoutError('checkout_not_active', `${state} So ${consequence}. Start a new Checkout.`, {
    status: checkout.status,
    lostReason: checkout.lostReason,
  });
}

export function applyInProgress({ id }: { id: string }): CheckoutError {
  return new CheckoutError('apply_in_progress', `Checkout ${id} is being Applied. Wait for that Apply to finish.`);
}

/** Team Mode, a Protected Profile requiring Approval: the requester asks for it instead of Applying. */
export function approvalRequired({ id, profile, queue }: Queue & { id: string; profile: { name: string } }): CheckoutError {
  return new CheckoutError(
    'approval_required',
    `${profile.name} is a Protected Profile: an Apply of "${queue}" that changes where a Message ends up needs a second Operator's Approval. ` +
      `Request Approval (POST /api/checkouts/${id}/approval-request) instead of Applying.`,
  );
}

/** Approval was requested for a Checkout whose Apply needs none: it can be Applied directly. */
export function approvalNotRequired({ queue, profile }: Queue & { profile: { name: string } }): CheckoutError {
  return new CheckoutError(
    'approval_not_required',
    `An Apply of "${queue}" on Broker Profile "${profile.name}" with these Decisions needs no Approval: Apply it directly.`,
  );
}

/** The Checkout waits for Approval: its Decisions are frozen and only an approver can Apply it. */
export function awaitingApproval({ vhost, queue }: Queue, consequence: string): CheckoutError {
  return new CheckoutError(
    'awaiting_approval',
    `The Checkout of "${queue}" in vhost "${vhost}" is waiting for Approval, so ${consequence}. Withdraw the request first.`,
  );
}

/** The Checkout is not (or no longer) waiting for Approval: never requested, withdrawn, approved or over. */
export function notAwaitingApproval({ id, status }: { id: string; status: CheckoutState }): CheckoutError {
  const why = status === 'active' ? 'no Approval is requested for it' : 'it is over';
  return new CheckoutError('not_awaiting_approval', `Checkout ${id} is not waiting for Approval: ${why}.`, { status });
}

export function cannotApproveOwnApply({ id }: { id: string }): CheckoutError {
  return new CheckoutError(
    'cannot_approve_own_apply',
    `Checkout ${id} is yours: its Apply needs Approval by another Operator with the role \`operator\` or \`admin\` on its Broker Profile.`,
  );
}
