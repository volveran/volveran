// Selection and Decision routes for a Checkout. Nothing here changes the
// broker: Decisions are staged in the Checkout until Apply (a Move
// destination is only looked up, to check that it exists).
//
//   POST /api/checkouts/:id/matching   { filter: FilterClause[] }      → { handles, count }
//   POST /api/checkouts/:id/decisions  { handles: number[], decision } → { checkout, rejected: [{ handle, reason }] }
//
// "Select all matching" (matching) only ever returns held Messages. Giving
// Keep clears a Decision.
import type { FastifyInstance } from 'fastify';
import { assertMoveDestinationExists } from '../checkout/move-destination.js';
import { matchingHandles, stageDecisions } from '../checkout/staging.js';
import { view } from '../checkout/view.js';
import { InvalidRequestError } from '../http-error.js';
import { decisionNotAllowed, parseDecision } from '../triage/decisions.js';
import { parseFilter } from '../triage/filters.js';
import { checkoutAccess, type CheckoutRouteDeps } from './checkouts.js';

export function registerDecisionRoutes(app: FastifyInstance, deps: CheckoutRouteDeps) {
  const { checkouts, toOwner } = deps;
  app.post<{ Params: { id: string }; Body: { filter?: unknown } | undefined }>(
    '/api/checkouts/:id/matching',
    toOwner,
    async (req) => {
      checkoutAccess(deps, req, 'checkout');
      const checkout = checkouts.checkout(req.params.id);
      const parsed = parseFilter(req.body?.filter);
      if (!parsed.ok) throw new InvalidRequestError(parsed.error);
      const handles = matchingHandles(checkout, parsed.filter);
      return { handles, count: handles.length };
    },
  );

  app.post<{ Params: { id: string }; Body: { handles?: unknown; decision?: unknown } | undefined }>(
    '/api/checkouts/:id/decisions',
    toOwner,
    async (req) => {
      const { management } = checkoutAccess(deps, req, 'checkout');
      const checkout = checkouts.checkout(req.params.id);
      const handles = req.body?.handles;
      if (!Array.isArray(handles) || !handles.every((h) => Number.isSafeInteger(h))) {
        throw new InvalidRequestError('"handles" must be a list of Message handles.');
      }
      const parsed = parseDecision(req.body?.decision);
      if (!parsed.ok) throw new InvalidRequestError(parsed.error);
      const { decision } = parsed;
      // Only worth asking the broker when staging could accept it.
      if (decision.kind === 'move' && checkout.status === 'active' && !decisionNotAllowed(decision, checkout.queue)) {
        await assertMoveDestinationExists(management, checkout, decision.destination);
      }
      const rejected = stageDecisions(checkout, handles as number[], decision);
      return { checkout: view(checkout), rejected };
    },
  );
}
