// Staging Decisions on a Checkout's held Messages, and "select all matching".
// Decisions live in the Checkout's memory on the server (so a reload of the
// page reads them back); nothing reaches the broker until Apply.
import { decisionNotAllowed, messageCannotTake, type Decision } from '../triage/decisions.js';
import { matchesFilter, type Filter } from '../triage/filters.js';
import { CheckoutError } from './errors.js';
import type { Checkout } from './state.js';

/** A Message that can't take a Decision, and why. */
export interface Rejection {
  handle: number;
  reason: string;
}

/**
 * Gives `decision` to the Messages `handles` (Keep clears their Decision).
 * Messages that can't take it keep their previous Decision and are returned.
 * Throws `checkout_not_active` once the Checkout is over, and
 * `decision_not_allowed` when no Message could take it (a Move to the queue
 * being triaged).
 */
export function stageDecisions(checkout: Checkout, handles: readonly number[], decision: Decision): Rejection[] {
  assertActive(checkout);
  const notAllowed = decisionNotAllowed(decision, checkout.queue);
  if (notAllowed) throw new CheckoutError('decision_not_allowed', notAllowed);

  const rejected: Rejection[] = [];
  for (const handle of new Set(handles)) {
    const message = checkout.held.get(handle);
    if (!message) {
      rejected.push({ handle, reason: `This Checkout holds no Message with handle ${handle}.` });
      continue;
    }
    const reason = messageCannotTake(decision, message);
    if (reason) rejected.push({ handle, reason });
    else if (decision.kind === 'keep') checkout.decisions.delete(handle);
    else checkout.decisions.set(handle, decision);
  }
  return rejected;
}

/** The handles of the held Messages matching `filter`, in Checkout order. */
export function matchingHandles(checkout: Checkout, filter: Filter): number[] {
  return [...checkout.held.entries()].filter(([, m]) => matchesFilter(filter, m)).map(([handle]) => handle);
}

function assertActive(checkout: Checkout) {
  if (checkout.status === 'active') return;
  throw new CheckoutError(
    'checkout_not_active',
    `The Checkout of "${checkout.queue}" in vhost "${checkout.vhost}" is ${checkout.status === 'lost' ? 'lost' : 'over'}: its Messages are back in the queue, so they can no longer take Decisions. Start a new Checkout.`,
  );
}
