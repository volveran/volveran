// The Apply route: carries out a Checkout's Decisions (ADR 0001).
//
//   POST /api/checkouts/:id/apply  { confirm: true }  → { checkout, outcomes: MessageOutcome[] }
//
// Under /api/checkouts/:id, so only the Checkout's owner may Apply it (the
// owner check in routes/checkouts.ts). Refused with 409 `checkout_not_active`
// on a Checkout that is over or lost, `apply_in_progress` while one runs.
// A dropped connection mid-Apply is not an error: the response lists what was
// done and what went back to the queue, and the Checkout is `lost`.
import type { FastifyInstance } from 'fastify';
import { ApplyError } from '../apply/errors.js';
import type { CheckoutManager } from '../checkout/manager.js';
import type { CheckoutView } from '../checkout/view.js';

export interface ApplyRequestBody {
  /** The Operator's single confirmation of the whole Apply, after seeing the summary of Decisions. */
  confirm?: unknown;
  /** #9: on a Protected Profile, the queue name as the Operator typed it. */
  confirmQueueName?: unknown;
}

/**
 * Throws unless the request carries the confirmation this Apply needs:
 * `{ confirm: true }`. #9 adds the typed queue name the Checkout's
 * `applyConfirmation.typeQueueName` asks for (triage/apply-confirmation.ts).
 */
export function checkApplyConfirmation(_checkout: CheckoutView, body: ApplyRequestBody | undefined): void {
  if (body?.confirm !== true) {
    throw new ApplyError(
      'confirmation_required',
      'Apply needs the Operator\'s confirmation: send { "confirm": true } after showing the summary of Decisions.',
    );
  }
}

export function registerApplyRoutes(app: FastifyInstance, checkouts: CheckoutManager) {
  app.post<{ Params: { id: string }; Body: ApplyRequestBody | undefined }>('/api/checkouts/:id/apply', async (req) => {
    // 404 for an unknown Checkout before asking for confirmation. Nothing
    // awaits between this check and apply() reading the Decisions.
    checkApplyConfirmation(checkouts.get(req.params.id), req.body);
    return checkouts.apply(req.params.id);
  });
}
