// What the API returns for a Checkout: its held Messages, each with its
// Decision, and the summary of the Decisions shown before Apply.
import { summaryText } from '../../shared/decisions.js';
import { applyConfirmationFor } from '../triage/apply-confirmation.js';
import { summarizeDecisions } from '../triage/decisions.js';
import { messageSummary, type QueueInfo } from '../triage/message-view.js';
import { replayOrigin } from '../triage/replay-origin.js';
import { remainingMs } from '../triage/checkout-timing.js';
import type { Checkout } from './state.js';
import type { ApprovalSummary, CheckoutView, MessageRow, ReplayAvailability } from '../../shared/checkout.js';

export type { ApprovalSummary, CheckoutView, MessageRow, ReplayAvailability };

export function queueInfo(c: Checkout): QueueInfo {
  return { type: c.queueType, deliveryLimit: c.deliveryLimit, deadLetterExchange: c.deadLetterExchange };
}

export function view(c: Checkout): CheckoutView {
  const info = queueInfo(c);
  const handles = [...c.held.keys()];
  const decisionSummary = summarizeDecisions(handles, c.decisions);
  return {
    id: c.id,
    profile: c.profile.name,
    protectedProfile: c.profile.protected,
    vhost: c.vhost,
    queue: c.queue,
    queueType: c.queueType,
    operator: c.operator.displayName,
    startedAt: c.startedAt.toISOString(),
    timeLimitMs: c.timing.timeLimitMs,
    endsAt: c.endsAt.toISOString(),
    remainingMs: c.status === 'active' ? remainingMs(c.endsAt, new Date()) : 0,
    heartbeatWindowMs: c.timing.heartbeatWindowMs,
    status: c.status === 'active' && c.approvalRequest ? 'awaiting_approval' : c.status,
    lostReason: c.lostReason,
    endReason: c.endReason,
    readyAtStart: c.readyAtStart,
    heldCount: c.held.size,
    heldBytes: c.heldBytes,
    limits: c.limits,
    limitedBy: c.limitedBy,
    deliveryLimit: c.deliveryLimit,
    messages: [...c.held.entries()].map(([handle, m]) => {
      const origin = replayOrigin(m.properties.headers);
      return {
        ...messageSummary(handle, m, info),
        decision: c.decisions.get(handle) ?? { kind: 'keep' },
        replay: origin.ok ? { available: true } : { available: false, reason: origin.reason },
      };
    }),
    decisionSummary,
    decisionSummaryText: summaryText(decisionSummary),
    applyConfirmation: applyConfirmationFor({
      protectedProfile: c.profile.protected,
      requireApproval: c.requireApproval,
      actionCount: handles.filter((h) => c.decisions.has(h)).length,
    }),
    approvalRequest: c.approvalRequest && { requestedAt: c.approvalRequest.requestedAt.toISOString() },
    rejection: c.rejection && { reason: c.rejection.reason, rejectedBy: c.rejection.rejectedBy, at: c.rejection.at.toISOString() },
    lastApply: c.lastApply,
  };
}

/** A Checkout waiting for Approval, as the approvers' list shows it. */
export function approvalSummary(c: Checkout & { approvalRequest: NonNullable<Checkout['approvalRequest']> }): ApprovalSummary {
  const decisionSummary = summarizeDecisions([...c.held.keys()], c.decisions);
  return {
    checkoutId: c.id,
    requester: c.operator.displayName,
    profile: c.profile.name,
    vhost: c.vhost,
    queue: c.queue,
    queueType: c.queueType,
    requestedAt: c.approvalRequest.requestedAt.toISOString(),
    waitingMs: Math.max(0, Date.now() - c.approvalRequest.requestedAt.getTime()),
    endsAt: c.endsAt.toISOString(),
    remainingMs: remainingMs(c.endsAt, new Date()),
    decisionSummary,
    decisionSummaryText: summaryText(decisionSummary),
  };
}
