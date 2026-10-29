// The Apply route: carries out a Checkout's Decisions (ADR 0001).
//
//   POST /api/checkouts/:id/apply  { confirm: true, confirmQueueName?, rate?, canary? }  → 202 { checkout }
//   POST /api/checkouts/:id/apply/stop                                                   → { checkout }
//   POST /api/checkouts/:id/apply/continue                                               → { checkout }
//
// `rate` is the Replay Rate in Messages per second (0.1 to 1,000): Replay and
// Move steps start at least 1/rate apart. Left out, the Broker Profile's
// `replayRate.default` applies, else the Apply is unthrottled. 400
// `invalid_request` for another value, 400 `rate_above_maximum` { max } above
// the profile's `replayRate.max` (or with no rate when it has a maximum but
// no default), 409 `apply_would_outlast_checkout` { neededMs, remainingMs }
// when at that rate it would outlast the Checkout's time left (less a margin).
//
// `canary` starts the Apply with a Canary: `true` for the first Message with
// the Decision Replay in Checkout order, `{ handle }` for that Message (it
// must have the Decision Replay; 400 `invalid_request` otherwise). 400
// `canary_needs_replay` when no Message has the Decision Replay. The Canary is
// Replayed alone and watched for the Broker Profile's Watch Window
// (`applyProgress.phase` canary_watch, then canary_done; its outcome is the
// Checkout's `canary`), then the Apply waits. Continue carries out the rest
// at the Apply's rate, also before the window ends; Stop returns the rest to
// the queue. Continue answers 409 `apply_not_waiting` unless the Apply waits
// after a Canary.
//
// The Apply runs in the background (ADR 0009): the answer comes at once,
// with the Checkout `applying`. Its view shows the Apply's progress
// (`applyProgress`), then the outcome for each Message (`lastApply`) once
// the Checkout has ended. Every refusal below answers before anything starts.
//
// On a Protected Profile, an Apply with any Decision other than Keep also needs
// `confirmQueueName` (400 `queue_name_confirmation_required`, protected-profile.ts).
//
// Under /api/checkouts/:id, so only the Checkout's owner may Apply it (the
// owner check in routes/checkouts.ts). Refused with 409 `checkout_not_active`
// on a Checkout that is over or lost, `apply_in_progress` while one runs.
// When the Apply needs Approval (Team Mode, a Protected Profile with
// `requireApproval`, any Decision other than Keep) it answers 409
// `approval_required`, and `awaiting_approval` once requested: the owner
// requests Approval instead (routes/approvals.ts).
// Stop asks the running Apply to attempt no further step: the step in
// progress finishes, the rest is reported `not-attempted` ("stopped by
// <name>") and goes back to the queue in order when the Checkout ends.
// `applyProgress.stoppedBy` names who stopped it. 409 `apply_not_running`
// when there is nothing to stop. The approver of an approved Apply stops it
// under /api/approvals/ (routes/approvals.ts).
// A dropped connection mid-Apply is not an error: the outcomes list what was
// done and what went back to the queue, and the Checkout is `lost`.
import type { FastifyInstance } from 'fastify';
import { ApplyError } from '../apply/errors.js';
import type { CheckoutView } from '../checkout/view.js';
import { operatorOf } from '../operator.js';
import { requireTypedQueueName } from '../protected-profile.js';
import { checkoutAccess, type CheckoutRouteDeps } from './checkouts.js';

export interface ApplyRequestBody {
  /** The Operator's single confirmation of the whole Apply, after seeing the summary of Decisions. */
  confirm?: unknown;
  /** #9: on a Protected Profile, the queue name as the Operator typed it. */
  confirmQueueName?: unknown;
  /** The Replay Rate in Messages per second; left out, the Broker Profile's default, else unthrottled. */
  rate?: unknown;
  /** Start with a Canary: true (the first Replay) or { handle }. */
  canary?: unknown;
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
  app.post<{ Params: { id: string }; Body: ApplyRequestBody | undefined }>('/api/checkouts/:id/apply', async (req, reply) => {
    const { role } = checkoutAccess(deps, req, 'checkout');
    // 404 for an unknown Checkout before asking for confirmation. Nothing
    // awaits between this check and apply() reading the Decisions.
    checkApplyConfirmation(checkouts.get(req.params.id), req.body);
    return reply.code(202).send({ checkout: checkouts.apply(req.params.id, role, req.body?.rate, req.body?.canary) });
  });

  app.post<{ Params: { id: string } }>('/api/checkouts/:id/apply/stop', async (req) => {
    checkoutAccess(deps, req, 'checkout');
    return { checkout: checkouts.stopApplyBy(req.params.id, operatorOf(req)) };
  });

  app.post<{ Params: { id: string } }>('/api/checkouts/:id/apply/continue', async (req) => {
    checkoutAccess(deps, req, 'checkout');
    return { checkout: checkouts.continueApplyBy(req.params.id, operatorOf(req)) };
  });
}
