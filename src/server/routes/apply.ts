// The Apply route: carries out a Checkout's Decisions (ADR 0001).
//
//   POST /api/checkouts/:id/apply  { confirm: true, confirmQueueName? }  → { checkout, outcomes: MessageOutcome[] }
//
// On a Protected Profile, an Apply with any Decision other than Keep also needs
// `confirmQueueName` (400 `queue_name_confirmation_required`, protected-profile.ts).
//
// Under /api/checkouts/:id, so only the Checkout's owner may Apply it (the
// owner check in routes/checkouts.ts). Refused with 409 `checkout_not_active`
// on a Checkout that is over or lost, `apply_in_progress` while one runs.
// A dropped connection mid-Apply is not an error: the response lists what was
// done and what went back to the queue, and the Checkout is `lost`.
import type { FastifyInstance } from 'fastify';
import { ApplyError } from '../apply/errors.js';
import type { CheckoutView } from '../checkout/view.js';
import { requireTypedQueueName } from '../protected-profile.js';
import { checkoutAccess, type CheckoutRouteDeps } from './checkouts.js';

export interface ApplyRequestBody {
  /** The Operator's single confirmation of the whole Apply, after seeing the summary of Decisions. */
  confirm?: unknown;
  /** #9: on a Protected Profile, the queue name as the Operator typed it. */
  confirmQueueName?: unknown;
}

/**
 * Throws unless the request carries the confirmation this Apply needs:
 * `{ confirm: true }`, plus on a Protected Profile the typed queue name when
 * the Checkout's `applyConfirmation.typeQueueName` asks for it (any Decision
 * other than Keep; triage/apply-confirmation.ts).
 */
export function checkApplyConfirmation(checkout: CheckoutView, body: ApplyRequestBody | undefined): void {
  if (body?.confirm !== true) {
    throw new ApplyError(
      'confirmation_required',
      'Apply needs the Operator\'s confirmation: send { "confirm": true } after showing the summary of Decisions.',
    );
  }
  if (checkout.applyConfirmation.typeQueueName) {
    requireTypedQueueName({ name: checkout.profile, protected: checkout.protectedProfile }, checkout.queue, body, 'Apply');
  }
}

export function registerApplyRoutes(app: FastifyInstance, deps: CheckoutRouteDeps) {
  const { checkouts } = deps;
  app.post<{ Params: { id: string }; Body: ApplyRequestBody | undefined }>('/api/checkouts/:id/apply', async (req) => {
    const { role } = checkoutAccess(deps, req, 'checkout');
    // 404 for an unknown Checkout before asking for confirmation. Nothing
    // awaits between this check and apply() reading the Decisions.
    checkApplyConfirmation(checkouts.get(req.params.id), req.body);
    return checkouts.apply(req.params.id, role);
  });
}
