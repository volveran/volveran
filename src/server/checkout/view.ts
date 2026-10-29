// What the API returns for a Checkout: its held Messages, each with its
// Decision, and the summary of the Decisions shown before Apply.
import { summaryText } from '../../shared/decisions.js';
import { applyConfirmationFor } from '../triage/apply-confirmation.js';
import { summarizeDecisions } from '../triage/decisions.js';
import { messageSummary, type QueueInfo } from '../triage/message-view.js';
import { replayOrigin } from '../triage/replay-origin.js';
import { remainingMs } from '../triage/checkout-timing.js';
import { pacedDurationMs } from '../../shared/replay-rate.js';
import type { RuleBadgeOf } from './manager.js';
import type { Checkout } from './state.js';
import { canaryView } from './canary.js';
import type { CanaryConfirmation } from '../../shared/checkout.js';
import type { ApprovalSummary, CheckoutView, MessageRow, ReplayAvailability } from '../../shared/checkout.js';

export type { ApprovalSummary, CheckoutView, MessageRow, ReplayAvailability };

export function queueInfo(c: Checkout): QueueInfo {
  return { type: c.queueType, deliveryLimit: c.deliveryLimit, deadLetterExchange: c.deadLetterExchange };
}

/** The Checkout as the API returns it; `ruleBadge` gives each row its running Replay Rule's badge. */
export function view(c: Checkout, ruleBadge?: RuleBadgeOf): CheckoutView {
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
    status: statusOf(c),
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
        replay: origin.ok
          ? { available: true }
          : { available: false, reason: origin.reason, suggestedMove: origin.suggestedMove },
        diedAgain: c.diedAgain.get(handle) ?? null,
        rule: ruleBadge?.(c, m, c.diedAgain.get(handle)?.count ?? 0) ?? null,
      };
    }),
    diedAgainCount: handles.filter((h) => c.diedAgain.has(h)).length,
    decisionSummary,
    decisionSummaryText: summaryText(decisionSummary),
    applyConfirmation: {
      ...applyConfirmationFor({
        protectedProfile: c.profile.protected,
        requireApproval: c.requireApproval,
        actionCount: handles.filter((h) => c.decisions.has(h)).length,
      }),
      replayRate: { ...c.profile.replayRate },
      estimatedDurationMs: pacedDurationMs(pacedSteps(c), c.approvalRequest ? c.approvalRequest.rate : c.profile.replayRate.default),
      canary: canaryConfirmation(c),
    },
    approvalRequest: c.approvalRequest && { requestedAt: c.approvalRequest.requestedAt.toISOString(), rate: c.approvalRequest.rate },
    rejection: c.rejection && { reason: c.rejection.reason, rejectedBy: c.rejection.rejectedBy, at: c.rejection.at.toISOString() },
    applyProgress: c.applyProgress?.view() ?? null,
    lastApply: c.lastApply,
    canary: c.canary && canaryView(c.canary),
  };
}

/** The Messages that may be the Canary (Decision Replay, in Checkout order), each with whether it can be watched. */
function canaryConfirmation(c: Checkout): CanaryConfirmation {
  const candidates: CanaryConfirmation['candidates'] = [];
  for (const handle of c.held.keys()) {
    if (c.decisions.get(handle)?.kind !== 'replay') continue;
    const bindings = c.canaryWatch.get(handle);
    candidates.push({
      handle,
      watch: bindings?.watchable
        ? { watchable: true }
        : { watchable: false, reason: bindings?.reason ?? 'Where this Message dead-letters is not known.' },
    });
  }
  return { watchWindowMs: c.profile.canary.watchWindowMs, candidates };
}

/** How many held Messages have a Decision that publishes (Replay, Move): the steps paced at a Replay Rate. */
export function pacedSteps(c: Checkout): number {
  let n = 0;
  for (const handle of c.held.keys()) {
    const kind = c.decisions.get(handle)?.kind;
    if (kind === 'replay' || kind === 'move') n++;
  }
  return n;
}

/** An Applying Checkout stays `applying` until the Apply has ended it and returned the rest; a lost one shows `lost` at once. */
function statusOf(c: Checkout): CheckoutView['status'] {
  if (c.status === 'lost') return 'lost';
  if (c.applying) return 'applying';
  if (c.status !== 'active') return c.status;
  return c.approvalRequest ? 'awaiting_approval' : 'active';
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
    rate: c.approvalRequest.rate,
  };
}
