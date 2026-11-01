// Approval routes (Team Mode, a Protected Profile with `requireApproval`):
// the owner of a Checkout requests Approval of its Apply instead of Applying,
// and a second Operator approves or rejects it.
//
// The owner (under /api/checkouts/:id, so the owner check of
// routes/checkouts.ts applies):
//   POST   /api/checkouts/:id/approval-request  { confirm: true, confirmQueueName, rate?, canary? }  → { checkout }
//          `rate` and `canary` as for an Apply (routes/apply.ts, incl. 400 `canary_required`), frozen with
//          the Decisions: the approved Apply runs at that rate and starts with that Canary
//   DELETE /api/checkouts/:id/approval-request  withdraws it                        → { checkout }
//
// Approvers (`operator` or `admin` on the Checkout's profile, never its owner):
//   GET  /api/approvals                              → { approvals: ApprovalSummary[] }
//   GET  /api/approvals/:checkoutId                  → { checkout }  read-only, the owner's shape
//   GET  /api/approvals/:checkoutId/messages/:handle → { message }
//   GET  /api/approvals/:checkoutId/compare?a=<handle>&b=<handle> → { left, right, diff }
//   POST /api/approvals/:checkoutId/approve  { confirmQueueName }  → 202 { checkout }  the Apply started, as for the owner's Apply
//        (409 `apply_would_outlast_checkout` when at the frozen rate too little time is left by now)
//   POST /api/approvals/:checkoutId/reject   { reason }            → { checkout }  back in staging
//   POST /api/approvals/:checkoutId/apply/stop                     → { checkout }  stops the Apply this approver approved
//   POST /api/approvals/:checkoutId/apply/continue                 → { checkout }  continues it after its Canary
//
// Once they have approved it, `GET /api/approvals/:checkoutId` keeps showing
// the approver the Checkout (its Apply's progress, its Canary, then its
// outcomes), and they may stop or continue that Apply as its owner can
// (routes/apply.ts); the Approval covered the whole plan, Canary included, so
// continuing needs no second one. Anyone else gets 403 `not_checkout_owner`.
//
// Errors: 409 `approval_not_required` (the Apply needs none), 409
// `awaiting_approval` (already requested), 409 `not_awaiting_approval`
// (nothing to withdraw, approve or reject; the message says what happened to
// the request), 403 `cannot_approve_own_apply`, the role
// errors of profile-access.ts, and 400 `queue_name_confirmation_required`
// for a missing or wrong typed queue name on request or approve, 400
// `invalid_request` for a rejection without a reason.
//
// With several Replicas, the list adds the Approvals waiting on the others, from their Live
// Checkout records, and every route naming a Checkout answers on its Owner Replica
// (replicas/forwarding.ts), where these checks run. A change to a request answers once its
// record is written, so what the Operator was told and the list on any Replica agree.
import type { FastifyInstance, FastifyRequest, onRequestAsyncHookHandler } from 'fastify';
import { InvalidRequestError } from '../http-error.js';
import { view, type ApprovalSummary } from '../checkout/view.js';
import { operatorOf, type Operator } from '../operator.js';
import { requireTypedQueueName } from '../protected-profile.js';
import { checkApplyConfirmation, type ApplyRequestBody } from './apply.js';
import { checkoutAccess, compareMessages, parseHandle, type CheckoutRouteDeps } from './checkouts.js';

export interface ApprovalRouteDeps extends CheckoutRouteDeps {
  /** `toOwner` for the routes that name the Checkout `:checkoutId`. */
  toOwnerOfApproval: { onRequest?: onRequestAsyncHookHandler };
  /** The Approvals waiting on other Replicas, except `approver`'s own; none when this Replica is on its own. */
  waitingElsewhere?(approver: Operator): Promise<ApprovalSummary[]>;
}

export function registerApprovalRoutes(app: FastifyInstance, deps: ApprovalRouteDeps) {
  const { checkouts, access, toOwner, toOwnerOfApproval, waitingElsewhere } = deps;

  app.post<{ Params: { id: string }; Body: ApplyRequestBody | undefined }>(
    '/api/checkouts/:id/approval-request',
    toOwner,
    async (req) => {
      const { role } = checkoutAccess(deps, req, 'checkout');
      checkApplyConfirmation(checkouts.get(req.params.id), req.body);
      const checkout = checkouts.requestApproval(req.params.id, role, req.body?.rate, req.body?.canary);
      await checkouts.liveRecordWritten(req.params.id);
      return { checkout };
    },
  );

  app.delete<{ Params: { id: string } }>('/api/checkouts/:id/approval-request', toOwner, async (req) => {
    checkoutAccess(deps, req, 'checkout');
    const checkout = checkouts.withdrawApproval(req.params.id);
    await checkouts.liveRecordWritten(req.params.id);
    return { checkout };
  });

  app.get('/api/approvals', async (req) => {
    const approver = operatorOf(req);
    const elsewhere = (await waitingElsewhere?.(approver)) ?? [];
    const approvals = [...checkouts.listAwaitingApproval(approver), ...elsewhere]
      .filter((a) => access.holds(approver, 'approve', a.profile))
      .sort((a, b) => Date.parse(a.requestedAt) - Date.parse(b.requestedAt));
    return { approvals };
  });

  /** The waiting Checkout, after the approver's Role, then that it is not theirs and still waits. */
  const awaiting = (req: FastifyRequest<{ Params: { checkoutId: string } }>) => {
    const approver = operatorOf(req);
    access.of(approver, 'approve', checkouts.checkout(req.params.checkoutId));
    return checkouts.awaitingCheckout(req.params.checkoutId, approver);
  };

  app.get<{ Params: { checkoutId: string } }>('/api/approvals/:checkoutId', toOwnerOfApproval, async (req) => {
    const approver = operatorOf(req);
    access.of(approver, 'approve', checkouts.checkout(req.params.checkoutId));
    return { checkout: view(checkouts.approvedBy(req.params.checkoutId, approver) ?? awaiting(req)) };
  });

  app.get<{ Params: { checkoutId: string; handle: string } }>(
    '/api/approvals/:checkoutId/messages/:handle',
    toOwnerOfApproval,
    async (req) => {
      const checkout = awaiting(req);
      return { message: await checkouts.message(checkout.id, parseHandle(req.params.handle)) };
    },
  );

  app.get<{ Params: { checkoutId: string }; Querystring: unknown }>('/api/approvals/:checkoutId/compare', toOwnerOfApproval, async (req) => {
    const checkout = awaiting(req);
    return compareMessages(checkouts, checkout.id, req.query);
  });

  app.post<{ Params: { checkoutId: string }; Body: { confirmQueueName?: unknown } | undefined }>(
    '/api/approvals/:checkoutId/approve',
    toOwnerOfApproval,
    async (req, reply) => {
      const checkout = awaiting(req);
      requireTypedQueueName(checkout.profile, checkout.queue, req.body, 'Approval');
      // Nothing awaits between these checks and approve() taking the request.
      const started = checkouts.approve(checkout.id, operatorOf(req));
      await checkouts.liveRecordWritten(checkout.id);
      return reply.code(202).send({ checkout: started });
    },
  );

  app.post<{ Params: { checkoutId: string } }>('/api/approvals/:checkoutId/apply/stop', toOwnerOfApproval, async (req) => {
    const approver = operatorOf(req);
    access.of(approver, 'approve', checkouts.checkout(req.params.checkoutId));
    return { checkout: checkouts.stopApplyBy(req.params.checkoutId, { operator: approver, as: 'approver' }) };
  });

  app.post<{ Params: { checkoutId: string } }>('/api/approvals/:checkoutId/apply/continue', toOwnerOfApproval, async (req) => {
    const approver = operatorOf(req);
    access.of(approver, 'approve', checkouts.checkout(req.params.checkoutId));
    return { checkout: checkouts.continueApplyBy(req.params.checkoutId, { operator: approver, as: 'approver' }) };
  });

  app.post<{ Params: { checkoutId: string }; Body: { reason?: unknown } | undefined }>(
    '/api/approvals/:checkoutId/reject',
    toOwnerOfApproval,
    async (req) => {
      const checkout = awaiting(req);
      const reason = typeof req.body?.reason === 'string' ? req.body.reason.trim() : '';
      if (reason === '') {
        throw new InvalidRequestError('A rejection needs a "reason": the requester sees it, so they know what to change.');
      }
      const rejected = checkouts.reject(checkout.id, operatorOf(req), reason);
      await checkouts.liveRecordWritten(checkout.id);
      return { checkout: rejected };
    },
  );
}
