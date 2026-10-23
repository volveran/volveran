// Selection and Decision routes for a Checkout. Nothing here touches the
// broker: Decisions are staged in the Checkout until Apply.
//
//   POST /api/checkouts/:id/matching   { filter: FilterClause[] }      → { handles, count }
//   POST /api/checkouts/:id/decisions  { handles: number[], decision } → { checkout, rejected: [{ handle, reason }] }
//
// "Select all matching" (matching) only ever returns held Messages. Giving
// Keep clears a Decision.
import type { FastifyInstance } from 'fastify';
import type { CheckoutManager } from '../checkout/manager.js';
import { matchingHandles, stageDecisions } from '../checkout/staging.js';
import { view } from '../checkout/view.js';
import { InvalidRequestError } from '../http-error.js';
import { parseDecision } from '../triage/decisions.js';
import { parseFilter } from '../triage/filters.js';

export function registerDecisionRoutes(app: FastifyInstance, checkouts: CheckoutManager) {
  app.post<{ Params: { id: string }; Body: { filter?: unknown } | undefined }>(
    '/api/checkouts/:id/matching',
    async (req) => {
      const checkout = checkouts.checkout(req.params.id);
      const parsed = parseFilter(req.body?.filter);
      if (!parsed.ok) throw new InvalidRequestError(parsed.error);
      const handles = matchingHandles(checkout, parsed.filter);
      return { handles, count: handles.length };
    },
  );

  app.post<{ Params: { id: string }; Body: { handles?: unknown; decision?: unknown } | undefined }>(
    '/api/checkouts/:id/decisions',
    async (req) => {
      const checkout = checkouts.checkout(req.params.id);
      const handles = req.body?.handles;
      if (!Array.isArray(handles) || !handles.every((h) => Number.isSafeInteger(h))) {
        throw new InvalidRequestError('"handles" must be a list of Message handles.');
      }
      const parsed = parseDecision(req.body?.decision);
      if (!parsed.ok) throw new InvalidRequestError(parsed.error);
      const rejected = stageDecisions(checkout, handles as number[], parsed.decision);
      return { checkout: view(checkout), rejected };
    },
  );
}
