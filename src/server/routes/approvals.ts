// Approval routes (Team Mode, a Protected Profile with `requireApproval`):
// the owner of a Checkout requests Approval of its Apply instead of Applying,
// and a second Operator approves or rejects it.
//
// The owner (under /api/checkouts/:id, so the owner check of
// routes/checkouts.ts applies):
//   POST   /api/checkouts/:id/approval-request  { confirm: true, confirmQueueName }  → { checkout }
//   DELETE /api/checkouts/:id/approval-request  withdraws it                        → { checkout }
//
// Approvers (`operator` or `admin` on the Checkout's profile, never its owner):
//   GET  /api/approvals                              → { approvals: ApprovalSummary[] }
//   GET  /api/approvals/:checkoutId                  → { checkout }  read-only, the owner's shape
//   GET  /api/approvals/:checkoutId/messages/:handle → { message }
//   GET  /api/approvals/:checkoutId/compare?a=<handle>&b=<handle> → { left, right, diff }
//   POST /api/approvals/:checkoutId/approve  { confirmQueueName }  → 202 { checkout }  the Apply started, as for the owner's Apply
//   POST /api/approvals/:checkoutId/reject   { reason }            → { checkout }  back in staging
//
// Errors: 409 `approval_not_required` (the Apply needs none), 409
// `awaiting_approval` (already requested), 409 `not_awaiting_approval`
// (nothing to withdraw, approve or reject; the message says what happened to
// the request), 403 `cannot_approve_own_apply`, the role
// errors of profile-access.ts, and 400 `queue_name_confirmation_required`
// for a missing or wrong typed queue name on request or approve, 400
// `invalid_request` for a rejection without a reason.
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { InvalidRequestError } from '../http-error.js';
import { view } from '../checkout/view.js';
import { operatorOf } from '../operator.js';
import { requireTypedQueueName } from '../protected-profile.js';
import { checkApplyConfirmation, type ApplyRequestBody } from './apply.js';
import { checkoutAccess, compareMessages, parseHandle, type CheckoutRouteDeps } from './checkouts.js';

export function registerApprovalRoutes(app: FastifyInstance, deps: CheckoutRouteDeps) {
  const { checkouts, access } = deps;

  app.post<{ Params: { id: string }; Body: ApplyRequestBody | undefined }>(
    '/api/checkouts/:id/approval-request',
    async (req) => {
      const { role } = checkoutAccess(deps, req, 'checkout');
      checkApplyConfirmation(checkouts.get(req.params.id), req.body);
      return { checkout: checkouts.requestApproval(req.params.id, role) };
    },
  );

  app.delete<{ Params: { id: string } }>('/api/checkouts/:id/approval-request', async (req) => {
    checkoutAccess(deps, req, 'checkout');
    return { checkout: checkouts.withdrawApproval(req.params.id) };
  });

  app.get('/api/approvals', async (req) => {
    const approver = operatorOf(req);
    const approvals = checkouts.listAwaitingApproval(approver).filter((a) => access.holds(approver, 'approve', a.profile));
    return { approvals };
  });

  /** The waiting Checkout, after the approver's Role, then that it is not theirs and still waits. */
  const awaiting = (req: FastifyRequest<{ Params: { checkoutId: string } }>) => {
    const approver = operatorOf(req);
    access.of(approver, 'approve', checkouts.checkout(req.params.checkoutId));
    return checkouts.awaitingCheckout(req.params.checkoutId, approver);
  };

  app.get<{ Params: { checkoutId: string } }>('/api/approvals/:checkoutId', async (req) => {
    return { checkout: view(awaiting(req)) };
  });

  app.get<{ Params: { checkoutId: string; handle: string } }>(
    '/api/approvals/:checkoutId/messages/:handle',
    async (req) => {
      const checkout = awaiting(req);
      return { message: checkouts.message(checkout.id, parseHandle(req.params.handle)) };
    },
  );

  app.get<{ Params: { checkoutId: string }; Querystring: unknown }>('/api/approvals/:checkoutId/compare', async (req) => {
    const checkout = awaiting(req);
    return compareMessages(checkouts, checkout.id, req.query);
  });

  app.post<{ Params: { checkoutId: string }; Body: { confirmQueueName?: unknown } | undefined }>(
    '/api/approvals/:checkoutId/approve',
    async (req, reply) => {
      const checkout = awaiting(req);
      requireTypedQueueName(checkout.profile, checkout.queue, req.body, 'Approval');
      // Nothing awaits between these checks and approve() taking the request.
      return reply.code(202).send({ checkout: checkouts.approve(checkout.id, operatorOf(req)) });
    },
  );

  app.post<{ Params: { checkoutId: string }; Body: { reason?: unknown } | undefined }>(
    '/api/approvals/:checkoutId/reject',
    async (req) => {
      const checkout = awaiting(req);
      const reason = typeof req.body?.reason === 'string' ? req.body.reason.trim() : '';
      if (reason === '') {
        throw new InvalidRequestError('A rejection needs a "reason": the requester sees it, so they know what to change.');
      }
      return { checkout: checkouts.reject(checkout.id, operatorOf(req), reason) };
    },
  );
}
