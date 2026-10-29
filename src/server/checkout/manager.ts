// Checkout manager (ADR 0006): the registry and lifecycle of every Checkout.
// Starting one opens its connection, takes the lock queue and collects the
// Messages (open.ts); Apply runs in apply.ts. The manager keeps the
// Checkouts, the in-process locks, the timers, and how a Checkout ends.
//
// Ending a Checkout nack-requeues every held Message one at a time in queue
// order, then the overflow, before closing the channel: on quorum queues that
// costs no Delivery Budget and keeps the order. A closed channel or
// connection (a crash, the network, a quorum consumer timeout arriving as a
// channel close) makes it a Lost Checkout: the broker has returned
// everything, at the cost of one delivery on quorum queues.
//
// A Checkout never holds Messages forever: it ends itself at its time limit,
// and when the browser has sent no heartbeat for the heartbeat window
// (checkout-timing.ts). On quorum queues its consumer carries
// `x-consumer-timeout` a margin past the time limit, as a backstop.
//
// Apply (ADR 0001, ADR 0009) runs in the background: starting it answers at
// once with the Checkout `applying`, whose view shows the Apply's progress.
// It ends the Checkout ('applied') once it has run: what is still held
// (Keep, failed, not attempted) goes back to the queue in order. While it
// runs, the heartbeat window is suspended (closing the browser does not
// cancel an Apply), and an Operator's end and shutdown wait for it. The time
// limit stays a hard bound: it asks the Apply to attempt no further step
// (the rest is reported not attempted), and the Checkout then ends
// ('time-limit'). The broker can still cut it short (Lost Checkout). The
// owner, or the approver of an approved Apply, can stop it the same way
// (stopApplyBy); the Checkout then ends ('applied'). Every stop checks and
// sets the request without awaiting, so the first of a stop, the time limit,
// a Lost Checkout and the Apply's last step wins.
//
// An Apply runs at a Replay Rate (the request's, else the Broker Profile's
// default, capped by its maximum; triage/replay-rate.ts) or with none. It
// is refused before it starts when at that rate it would outlast the
// Checkout's time left. A stop wakes a wait for the next paced step at once.
//
// An Apply can start with a Canary (canary.ts): one Replay carried out
// alone, watched for the profile's Watch Window, after which the Apply waits
// with the Checkout active (Decisions frozen, time limit and heartbeat
// running) until the owner, or the approver of an approved Apply, continues
// (continueApplyBy) or stops it. The Checkout ending or being lost while it
// waits stops it too: the rest is reported not attempted.
//
// Approval (Team Mode, a Protected Profile with `requireApproval`): an Apply
// with any Decision other than Keep is not run by its owner. The owner
// requests Approval, which freezes the Decisions (the Checkout is
// `awaiting_approval`, still active: the time limit and heartbeat keep
// running), and a second Operator approves it, which runs the Apply on the
// owner's Checkout and connection, or rejects it with a reason, which puts
// the Checkout back in staging. Withdraw, approve, reject and the Checkout's
// end each check and change the request without awaiting first, so the first
// one wins and the others find no request (409 `not_awaiting_approval`, which
// says what happened to it). Ending the Checkout cancels it.
//
// In-process, an Operator (keyed by `Operator.id`) has at most one active Checkout, and a queue at
// most one (checked before the broker's lock, so the holder is known exactly).
import { randomUUID } from 'node:crypto';
import type { Operator } from '../operator.js';
import type { QueueAccess } from '../profile-access.js';
import { queueRefOf, type QueueRef } from '../profiles.js';
import { MAX_REPLAY_RATE, MIN_REPLAY_RATE } from '../../shared/replay-rate.js';
import { canaryNeedsReplay, canaryRequired, rateAboveMaximum } from '../apply/errors.js';
import type { RuleActing } from '../apply/types.js';
import { InvalidRequestError } from '../http-error.js';
import { isRecord } from '../is-record.js';
import type { CheckoutLimits } from '../triage/checkout-collection.js';
import type { Filter } from '../triage/filters.js';
import { DEFAULT_CHECKOUT_TIMING, remainingMs, type CheckoutTiming } from '../triage/checkout-timing.js';
import { applyOutlastsCheckout, resolveReplayRate } from '../triage/replay-rate.js';
import { messageDetail, type Delivery, type MessageDetail } from '../triage/message-view.js';
import type { RuleSchedulerTestHooks } from '../replay-rules/scheduler.js';
import type { RuleBadge } from '../../shared/replay-rules.js';
import { replayTrail } from '../audit/replay-trail.js';
import type { AuditStore, ProfileScope } from '../audit/store.js';
import { diedAgain } from '../triage/died-again.js';
import type { Role } from '../../shared/roles.js';
import { runApply } from './apply.js';
import {
  applyInProgress,
  applyNotRunning,
  applyNotWaiting,
  approvalNotRequired,
  approvalRequired,
  applyWouldOutlastCheckout,
  awaitingApproval,
  cannotApproveOwnApply,
  CheckoutError,
  checkoutNotActive,
  inCheckout,
  notApplyApprover,
  notAwaitingApproval,
  notCheckoutOwner,
  operatorHasCheckout,
} from './errors.js';
import { startExport, type CheckoutExport } from './export.js';
import { openCheckout, type StartOptions } from './open.js';
import type { ApplyStop, ApprovalClosed, ApprovalRequest, Checkout, EndReason, RunningApply } from './state.js';
import { approvalSummary, pacedSteps, queueInfo, view as checkoutView, type ApprovalSummary, type CheckoutView } from './view.js';

export { checkoutConnectionName, type StartOptions } from './open.js';

/**
 * Test seams: awaited where a race with the broker or another request
 * decides the outcome, so a test can act there deterministically.
 */
export interface CheckoutTestHooks {
  /** A start holds the queue's lock queue; next it reads the ready count and collects. */
  afterLock?(ref: QueueRef): Promise<void>;
  /** A start has stopped waiting for deliveries; next it cancels its consumer. */
  afterCollectWait?(ref: QueueRef): Promise<void>;
  /** A start has collected its Messages: the prefetch of each window, and how many deliveries overflowed the byte limit. */
  afterCollect?(ref: QueueRef, collected: { windows: number[]; overflow: number }): Promise<void>;
  /** A Checkout reached its time limit; next it ends itself. */
  beforeTimeLimitEnd?(ref: QueueRef): Promise<void>;
  /** An Apply step's `pending` Audit Entry is committed; next the step touches the broker (e.g. the ack of a Discard). */
  beforeApplyStep?(entryId: number): Promise<void>;
  /** An export is about to make the line of the Message at `position` (1 is the head of the queue). */
  beforeExportLine?(position: number): Promise<void>;
  /** The Replay Rule scheduler's clock and "run a pass now" (replay-rules/scheduler.ts); the server hands them to it. */
  ruleScheduler?: RuleSchedulerTestHooks;
}

/** A running Replay Rule's badge for one held Message (replay-rules/rules.ts); null when no running rule matches it. */
export type RuleBadgeOf = (checkout: Checkout, delivery: Delivery, diedAgainCount: number) => RuleBadge | null;

export interface CheckoutStartOptions extends StartOptions {
  /**
   * The Broker Profiles whose Audit Entries the Operator may read (the access
   * check's audit scope): Died Again shows no entry outside them. Every
   * profile when left out.
   */
  auditScope?: ProfileScope;
  /** Holds at most this many Messages, below the Checkout Message limit (a Rule Pass). */
  maxMessages?: number;
}

export interface CheckoutManagerOptions {
  /** Where Apply writes its Audit Entries. */
  audit: AuditStore;
  limits: CheckoutLimits;
  /**
   * Team Mode: Protected Profiles with `requireApproval` need Approval for an
   * Apply. False in Solo Mode, which ignores `requireApproval`.
   */
  enforceApproval?: boolean;
  /** Time limit, heartbeat window and quorum backstop margin (default DEFAULT_CHECKOUT_TIMING). */
  timing?: CheckoutTiming;
  /** How long an ended or lost Checkout stays readable before it is forgotten. */
  endedRetentionMs?: number;
  testHooks?: CheckoutTestHooks;
  /** The rule badge on Message rows and in the Message view; none when left out. */
  ruleBadge?: RuleBadgeOf;
  /** An Apply running in the background failed unexpectedly (its steps report their own failures); the Checkout still ends. */
  onApplyError?(checkoutId: string, err: unknown): void;
}

/** The reason of the steps an Apply did not reach before the Checkout's time limit. */
const TIME_LIMIT_REASON = 'The Checkout reached its time limit before this Message; it is back in the queue.';

/** The reason of the steps an Apply did not reach because an Operator stopped it. */
const stoppedByReason = (name: string) => `Stopped by ${name} before this Message; it is back in the queue.`;

/** The reason of the steps an Apply did not reach because the Checkout ended while it waited after its Canary. */
const endedWhileWaitingReason = 'The Checkout ended while the Apply waited after its Canary; this Message is back in the queue.';

const DEFAULT_ENDED_RETENTION_MS = 15 * 60_000;

export class CheckoutManager {
  private readonly checkouts = new Map<string, Checkout>();
  /** Lock key (broker + vhost + queue) → the Checkout holding it, from the moment it starts. */
  private readonly locks = new Map<string, Checkout>();
  /** Operator id → their Checkout, from the moment it starts until it is over. */
  private readonly byOperator = new Map<string, Checkout>();
  private readonly hooks: CheckoutTestHooks;
  private readonly endedRetentionMs: number;
  private readonly timing: CheckoutTiming;

  constructor(private readonly options: CheckoutManagerOptions) {
    this.hooks = options.testHooks ?? {};
    this.timing = options.timing ?? DEFAULT_CHECKOUT_TIMING;
    this.endedRetentionMs = options.endedRetentionMs ?? DEFAULT_ENDED_RETENTION_MS;
  }

  /**
   * Starts a Checkout of `target`, a queue resolved through the access check
   * (its management client and the Operator's broker credentials included).
   */
  async start(target: QueueAccess, operator: Operator, options: CheckoutStartOptions = {}): Promise<CheckoutView> {
    const ref = queueRefOf(target);
    const mine = this.byOperator.get(operator.id);
    if (mine) throw operatorHasCheckout(operator.displayName, mine);
    const lockKey = this.lockKey(ref);
    const other = this.locks.get(lockKey);
    if (other) throw inCheckout(ref, { operator: other.operator.displayName, since: other.startedAt.toISOString() });

    const startedAt = new Date();
    const checkout: Checkout = {
      ...ref,
      id: randomUUID(),
      operator,
      // Set from the credentials the connection opens with (open.ts).
      brokerUser: '',
      queueType: 'classic',
      deliveryLimit: null,
      deadLetterExchange: false,
      startedAt,
      timing: this.timing,
      endsAt: new Date(startedAt.getTime() + this.timing.timeLimitMs),
      timeLimitTimer: undefined,
      heartbeatTimer: undefined,
      status: 'active',
      requireApproval: (this.options.enforceApproval ?? false) && target.profile.protected && target.profile.requireApproval,
      approvalRequest: null,
      approvalClosed: null,
      rejection: null,
      lostReason: null,
      endReason: null,
      readyAtStart: 0,
      limits:
        options.maxMessages === undefined
          ? this.options.limits
          : { ...this.options.limits, maxMessages: Math.min(options.maxMessages, this.options.limits.maxMessages) },
      limitedBy: null,
      connection: undefined,
      channel: undefined,
      held: new Map(),
      overflow: [],
      heldBytes: 0,
      diedAgain: new Map(),
      decisions: new Map(),
      applying: null,
      applyProgress: null,
      lastApply: null,
      canaryWatch: new Map(),
      canary: null,
    };
    this.locks.set(lockKey, checkout);
    this.byOperator.set(operator.id, checkout);
    try {
      await openCheckout(checkout, target, options, {
        onLost: (reason) => this.markLost(checkout, reason),
        afterLock: this.hooks.afterLock,
        afterCollectWait: this.hooks.afterCollectWait,
        afterCollect: this.hooks.afterCollect,
      });
    } catch (err) {
      this.release(checkout);
      await checkout.connection?.close().catch(() => {});
      throw err;
    }
    this.findDiedAgain(checkout, options.auditScope);
    this.checkouts.set(checkout.id, checkout);
    if (checkout.status === 'active') this.startTimers(checkout);
    return this.view(checkout);
  }

  /** The browser still shows the Checkout: it stays until the next heartbeat window passes. */
  heartbeat(id: string): CheckoutView {
    const checkout = this.find(id);
    // While an Apply runs the heartbeat window is suspended, except while it waits after a Canary.
    if (checkout.status === 'active' && (!checkout.applying || checkout.applying.resume)) checkout.heartbeatTimer?.refresh();
    return this.view(checkout);
  }

  /**
   * Only the Checkout's owner may use it: throws 403 `not_checkout_owner`
   * when another Operator asks (before anything of it is read). An unknown
   * id passes; the action that follows reports it.
   */
  checkOwner(id: string, operator: Operator): void {
    const checkout = this.checkouts.get(id);
    if (checkout && checkout.operator.id !== operator.id) throw notCheckoutOwner(id);
  }

  get(id: string): CheckoutView {
    return this.view(this.find(id));
  }

  /** Whether Checkout `id` is active or still Applying in this process, so its pending Audit Entries may yet finish. */
  isRunning(id: string): boolean {
    const checkout = this.checkouts.get(id);
    return checkout !== undefined && (checkout.status === 'active' || checkout.applying !== null);
  }

  /** The Checkout itself, for the modules that work on its held Messages (staging.ts). */
  checkout(id: string): Checkout {
    return this.find(id);
  }

  /** The active Checkout of the Operator with this id, if any. */
  activeFor(operatorId: string): CheckoutView | null {
    const c = this.byOperator.get(operatorId);
    return c && this.checkouts.has(c.id) ? this.view(c) : null;
  }

  message(id: string, handle: number): MessageDetail {
    const checkout = this.find(id);
    const m = checkout.held.get(handle);
    if (!m) throw new CheckoutError('message_not_found', `Checkout ${id} holds no Message with handle ${handle}.`);
    const diedAgain = checkout.diedAgain.get(handle) ?? null;
    return {
      ...messageDetail(handle, m, queueInfo(checkout)),
      diedAgain,
      rule: this.options.ruleBadge?.(checkout, m, diedAgain?.count ?? 0) ?? null,
    };
  }

  private view(checkout: Checkout): CheckoutView {
    return checkoutView(checkout, this.options.ruleBadge);
  }

  /** Recognises the held Messages that are Died Again, once, as they are held (their replay ids never change). */
  private findDiedAgain(checkout: Checkout, auditScope: ProfileScope | undefined): void {
    const trail = replayTrail(this.options.audit, auditScope);
    for (const [handle, m] of checkout.held) {
      const found = diedAgain(m.properties.headers, trail);
      if (found) checkout.diedAgain.set(handle, found);
    }
  }

  /**
   * Starts carrying out every Decision of the Checkout in the background (ADR
   * 0001), which then ends it: Messages whose Decision is Keep, failed or was
   * not attempted go back to the queue in order. Returns the Checkout
   * `applying`; the outcome for each Message lands in its `lastApply`.
   * Throws, before starting anything, `checkout_not_active` on a Checkout
   * that is over or lost, `apply_in_progress` while one runs,
   * `approval_required` when the Apply needs Approval and
   * `awaiting_approval` while it waits for it, and the Replay Rate's
   * refusals (replayRateFor). `role` is the Applying Operator's Role on the
   * profile, recorded in each Audit Entry. `rate` is the request's Replay
   * Rate as sent (left out: the profile's default). `canary` is the
   * request's Canary as sent (canaryFor).
   */
  apply(id: string, role: Role, rate?: unknown, canary?: unknown): CheckoutView {
    const checkout = this.find(id);
    this.assertCanApply(checkout);
    if (checkout.approvalRequest) throw awaitingApproval(checkout, 'only an approver can Apply it');
    if (this.view(checkout).applyConfirmation.approvalRequired) throw approvalRequired(checkout);
    const canaryHandle = this.canaryFor(checkout, canary);
    return this.startApply(checkout, role, null, this.replayRateFor(checkout, rate), { canary: canaryHandle });
  }

  /**
   * The handle of the Apply's Canary from the request's `canary`: left out
   * or false for none, true for the first Message with the Decision Replay
   * in Checkout order, `{ handle }` for that Message, which must have the
   * Decision Replay. Throws 400 `canary_needs_replay` when a Canary is asked
   * for and no Message has the Decision Replay, 400 `canary_required` when
   * none is and the profile requires one for this many Replays, 400
   * `invalid_request` for anything else.
   */
  private canaryFor(checkout: Checkout, requested: unknown): number | null {
    const replays = [...checkout.held.keys()].filter((h) => checkout.decisions.get(h)?.kind === 'replay');
    if (requested === undefined || requested === null || requested === false) {
      const { requiredAbove } = checkout.profile.canary;
      if (requiredAbove !== null && replays.length > requiredAbove) {
        throw canaryRequired(checkout.profile.name, requiredAbove, replays.length);
      }
      return null;
    }
    const picked = isRecord(requested) ? requested.handle : undefined;
    if (requested !== true && !(typeof picked === 'number' && Number.isInteger(picked))) {
      throw new InvalidRequestError('"canary" must be true (the first Replay is the Canary), { "handle": <Message handle> }, or left out.');
    }
    if (replays.length === 0) throw canaryNeedsReplay();
    if (requested === true) return replays[0]!;
    if (!replays.includes(picked as number)) {
      throw new InvalidRequestError(`The Canary must be a held Message with the Decision Replay; Message ${String(picked)} is not.`);
    }
    return picked as number;
  }

  /**
   * A Rule Pass Applies its Checkout's Decisions (ADR 0011): as the rule,
   * with the role `operator`, at the rule's Replay Rate, with no Approval and
   * no confirmation (the review of the profiles file stands in for both).
   * Resolves once the Apply has run and the Checkout has ended, with the
   * Checkout as it ended. Throws `checkout_not_active` and
   * `apply_in_progress` as apply() does.
   */
  async applyForRule(id: string, { rate, rule }: { rate: number; rule: RuleActing }): Promise<CheckoutView> {
    const checkout = this.find(id);
    this.assertCanApply(checkout);
    this.startApply(checkout, 'operator', null, rate, { rule });
    await checkout.applying?.settled;
    return this.view(checkout);
  }

  /**
   * The Replay Rate an Apply of the Checkout runs at, from the request's
   * `requested` rate and the profile's `replayRate`. Throws 400
   * `invalid_request` for a rate that is not a number from 0.1 to 1,000, 400
   * `rate_above_maximum`, and 409 `apply_would_outlast_checkout` when the
   * Replay and Move steps at that rate would outlast the time left.
   */
  private replayRateFor(checkout: Checkout, requested: unknown): number | null {
    const resolved = resolveReplayRate(requested, checkout.profile.replayRate, { pacedSteps: pacedSteps(checkout) });
    if (!resolved.ok && resolved.problem === 'invalid') {
      throw new InvalidRequestError(
        `"rate" must be a number of Messages per second from ${MIN_REPLAY_RATE} to ${MAX_REPLAY_RATE}, or left out.`,
      );
    }
    if (!resolved.ok) throw rateAboveMaximum(checkout.profile.name, resolved.max, (requested as number | null | undefined) ?? null);
    this.assertFitsTimeLeft(checkout, resolved.rate);
    return resolved.rate;
  }

  /** Throws `apply_would_outlast_checkout` when the Apply's paced steps at `rate` would outlast the Checkout. */
  private assertFitsTimeLeft(checkout: Checkout, rate: number | null): void {
    const outlasts = applyOutlastsCheckout({
      pacedSteps: pacedSteps(checkout),
      rate,
      remainingMs: remainingMs(checkout.endsAt, new Date()),
    });
    if (outlasts) throw applyWouldOutlastCheckout(checkout, outlasts);
  }

  /**
   * The owner asks for Approval of the Apply of the current Decisions, which
   * freezes them, with the Replay Rate the Apply will run at (`rate` as
   * sent). `role` is the owner's Role on the profile, recorded when the
   * Apply runs. Throws `approval_not_required` when the Apply needs no
   * Approval, `awaiting_approval` when it is already requested, and the
   * Replay Rate's refusals (replayRateFor). `canary` is the request's
   * Canary as sent, frozen too: the approved Apply starts with it (same
   * refusals as for an Apply, canaryFor).
   */
  requestApproval(id: string, role: Role, rate?: unknown, canary?: unknown): CheckoutView {
    const checkout = this.find(id);
    this.assertCanApply(checkout);
    if (checkout.approvalRequest) throw awaitingApproval(checkout, 'Approval is already requested');
    if (!this.view(checkout).applyConfirmation.approvalRequired) throw approvalNotRequired(checkout);
    const frozenCanary = this.canaryFor(checkout, canary);
    const frozenRate = this.replayRateFor(checkout, rate);
    checkout.approvalRequest = { requestedAt: new Date(), role, rate: frozenRate, canary: frozenCanary };
    checkout.approvalClosed = null;
    checkout.rejection = null;
    return this.view(checkout);
  }

  /** The owner withdraws the request: the Decisions can change again. Throws `not_awaiting_approval`. */
  withdrawApproval(id: string): CheckoutView {
    const checkout = this.find(id);
    this.takeApprovalRequest(checkout, { how: 'withdrawn' });
    return this.view(checkout);
  }

  /** The Checkouts waiting for Approval, oldest request first, except `approver`'s own. */
  listAwaitingApproval(approver: Operator): ApprovalSummary[] {
    return [...this.checkouts.values()]
      .filter(
        (c): c is Checkout & { approvalRequest: ApprovalRequest } =>
          c.status === 'active' && c.approvalRequest !== null && c.operator.id !== approver.id,
      )
      .sort((a, b) => a.approvalRequest.requestedAt.getTime() - b.approvalRequest.requestedAt.getTime())
      .map(approvalSummary);
  }

  /**
   * Checkout `id` as `approver` may see it before approving: throws 404
   * `checkout_not_found`, 403 `cannot_approve_own_apply` for its owner, 409
   * `not_awaiting_approval` unless it waits for Approval. The caller checks
   * the approver's Role first (profile-access.ts, capability `approve`).
   */
  awaitingCheckout(id: string, approver: Operator): Checkout {
    const checkout = this.find(id);
    if (checkout.operator.id === approver.id) throw cannotApproveOwnApply(checkout);
    if (checkout.status !== 'active' || !checkout.approvalRequest) throw notAwaitingApproval(checkout);
    return checkout;
  }

  /** Checkout `id` when `approver` approved its Apply (to follow its progress and outcomes), else null. */
  approvedBy(id: string, approver: Operator): Checkout | null {
    const checkout = this.find(id);
    const closed = checkout.approvalClosed;
    return closed?.how === 'approved' && closed.approverId === approver.id ? checkout : null;
  }

  /**
   * A second Operator approves the requested Apply: it starts in the
   * background on the owner's Checkout, recorded as the owner's (with the
   * Role they held when they asked) and with `approver` alongside, at the
   * Replay Rate and the Canary frozen with the request. Returns the
   * Checkout `applying`. After a Canary, the owner or this approver
   * continues it (continueApplyBy) with no second Approval.
   * Same checks as awaitingCheckout, and `apply_would_outlast_checkout` when
   * too little time is left by now (the request stays).
   */
  approve(id: string, approver: Operator): CheckoutView {
    const checkout = this.awaitingCheckout(id, approver);
    this.assertFitsTimeLeft(checkout, checkout.approvalRequest!.rate);
    const request = this.takeApprovalRequest(checkout, { how: 'approved', by: approver.displayName, approverId: approver.id });
    return this.startApply(checkout, request.role, approver, request.rate, { canary: request.canary });
  }

  /**
   * A second Operator rejects the requested Apply: the Checkout is back in
   * staging, and its owner sees `reason` and who rejected it until they
   * request again. Same checks as awaitingCheckout.
   */
  reject(id: string, approver: Operator, reason: string): CheckoutView {
    const checkout = this.awaitingCheckout(id, approver);
    this.takeApprovalRequest(checkout, { how: 'rejected', by: approver.displayName });
    checkout.rejection = { reason, rejectedBy: approver.displayName, at: new Date() };
    return this.view(checkout);
  }

  /** Removes the request for Approval, which must exist; no await before the caller acts on it. */
  private takeApprovalRequest(checkout: Checkout, closed: ApprovalClosed): ApprovalRequest {
    const request = checkout.approvalRequest;
    if (checkout.status !== 'active' || !request) throw notAwaitingApproval(checkout);
    checkout.approvalRequest = null;
    checkout.approvalClosed = closed;
    return request;
  }

  /** The Checkout is ending: a request still waiting is cancelled with it. */
  private cancelApprovalRequest(checkout: Checkout) {
    if (!checkout.approvalRequest) return;
    checkout.approvalRequest = null;
    checkout.approvalClosed = { how: 'cancelled' };
  }

  private assertCanApply(checkout: Checkout) {
    if (checkout.status !== 'active') throw checkoutNotActive(checkout, 'nothing can be Applied');
    if (checkout.applying) throw applyInProgress(checkout);
  }

  /**
   * Starts the Apply in the background, with no await before the Checkout
   * is `applying` (so a second Apply or approve finds it in progress), and
   * suspends the heartbeat window while it runs.
   */
  private startApply(
    checkout: Checkout,
    role: Role,
    approver: Operator | null,
    rate: number | null,
    { canary = null, rule = null }: { canary?: number | null; rule?: RuleActing | null } = {},
  ): CheckoutView {
    clearTimeout(checkout.heartbeatTimer);
    const running: RunningApply = { settled: Promise.resolve(), stop: null, stopped: new AbortController(), resume: null };
    checkout.applying = running;
    running.settled = this.carryOutApply(checkout, running, { role, approver, rate, canary, rule });
    return this.view(checkout);
  }

  private async carryOutApply(
    checkout: Checkout,
    running: RunningApply,
    {
      role,
      approver,
      rate,
      canary,
      rule,
    }: { role: Role; approver: Operator | null; rate: number | null; canary: number | null; rule: RuleActing | null },
  ) {
    try {
      const { startedAt, outcomes } = await runApply(checkout, {
        audit: this.options.audit,
        role,
        approver: approver && { id: approver.id, displayName: approver.displayName },
        rate,
        rule,
        stopReason: () => running.stop?.reason ?? null,
        stopSignal: running.stopped.signal,
        beforeStep: this.hooks.beforeApplyStep,
        canary: canary === null ? undefined : {
          handle: canary,
          watchWindowMs: checkout.profile.canary.watchWindowMs,
          // The Checkout stays active while the Apply waits: its heartbeat window runs again.
          waiting: (resume) => {
            if (running.resume) return;
            running.resume = resume;
            if (checkout.status === 'active') this.armHeartbeat(checkout);
          },
          resumed: () => {
            running.resume = null;
            clearTimeout(checkout.heartbeatTimer);
          },
        },
      });
      checkout.lastApply = { at: startedAt.toISOString(), outcomes, approvedBy: approver?.displayName ?? null };
    } catch (err) {
      this.options.onApplyError?.(checkout.id, err);
    }
    // Still `applying` until every Message not done is back in the queue; an
    // end() that waited for this Apply then finds the Checkout already ended.
    await this.finish(checkout, running.stop?.endReason ?? 'applied').catch(() => {});
    checkout.applying = null;
  }

  /**
   * `operator` stops the Checkout's Apply: the step in progress finishes, and
   * every step left is reported not attempted, "stopped by" them, and goes
   * back to the queue with the Checkout's end. The caller has checked that
   * `operator` owns the Checkout, or (`asApprover`) holds the `approve`
   * capability; here the approver must be the one who approved this Apply
   * (403 `not_checkout_owner` otherwise). Throws 409 `apply_not_running` when
   * nothing is left to stop: no Apply runs, it has attempted its last step,
   * the Checkout was lost, or a stop (the time limit, another Operator) came
   * first. Nothing awaits, so this and those are serialised per Checkout.
   */
  stopApplyBy(id: string, operator: Operator, asApprover = false): CheckoutView {
    const checkout = this.find(id);
    if (asApprover && !this.approvedBy(id, operator)) throw notApplyApprover(id);
    const running = checkout.applying;
    if (!running) throw applyNotRunning(checkout, 'none is running');
    if (checkout.status === 'lost') throw applyNotRunning(checkout, 'the Checkout was lost, so its Apply attempts no further step');
    if (running.stop) {
      const by = running.stop.stoppedBy ?? (running.stop.endReason === 'time-limit' ? 'the time limit' : 'the Checkout ending');
      throw applyNotRunning(checkout, `${by} already stopped it`);
    }
    if (checkout.applyProgress?.view().remaining === 0) throw applyNotRunning(checkout, 'it has attempted every step');
    const name = operator.displayName;
    this.stopApply(checkout, { reason: stoppedByReason(name), endReason: 'applied', stoppedBy: name });
    return this.view(checkout);
  }

  /**
   * `operator` lets the Apply waiting after its Canary carry out every
   * remaining step, at its Replay Rate; allowed before the Watch Window
   * ends, which ends the watch. Same checks of who may as stopApplyBy.
   * Throws 409 `apply_not_waiting` unless the Apply waits after a Canary and
   * nothing stopped it first. Nothing awaits, so this and a stop are
   * serialised per Checkout.
   */
  continueApplyBy(id: string, operator: Operator, asApprover = false): CheckoutView {
    const checkout = this.find(id);
    if (asApprover && !this.approvedBy(id, operator)) throw notApplyApprover(id);
    const running = checkout.applying;
    if (!running) throw applyNotWaiting(checkout, 'no Apply is running');
    if (checkout.status === 'lost') throw applyNotWaiting(checkout, 'the Checkout was lost');
    if (running.stop) throw applyNotWaiting(checkout, 'it was stopped');
    if (!running.resume) throw applyNotWaiting(checkout, 'it is not waiting after a Canary');
    running.resume();
    running.resume = null;
    clearTimeout(checkout.heartbeatTimer);
    return this.view(checkout);
  }

  /**
   * Asks the Apply running on the Checkout to attempt no further step; the
   * step in progress finishes, and a wait for the next paced step ends at
   * once. The first stop wins.
   */
  private stopApply(checkout: Checkout, stop: ApplyStop): void {
    const running = checkout.applying;
    if (!running || running.stop) return;
    running.stop = stop;
    running.stopped.abort();
    if (stop.stoppedBy && checkout.applyProgress) checkout.applyProgress.stoppedBy = stop.stoppedBy;
  }

  /**
   * Starts an NDJSON export of the held Messages matching `filter` (every
   * one when null) and records its Audit Entry (export.ts). Changes nothing
   * on the broker. Throws `checkout_not_active` on a Checkout that is over
   * or lost. `role` is the exporting Operator's Role, recorded in the Audit Entry.
   */
  exportMessages(id: string, filter: Filter | null, role: Role): CheckoutExport {
    return startExport(this.find(id), filter, { audit: this.options.audit, role, beforeLine: this.hooks.beforeExportLine });
  }

  /** Ends the Checkout: every held Message goes back to the queue untouched, in its original order. */
  async end(id: string, reason: EndReason = 'operator'): Promise<CheckoutView> {
    const checkout = this.find(id);
    // An Apply in progress finishes first (it ends the Checkout itself), so
    // a done step is never returned and no step is cut short. With none,
    // finish() runs now, before any await: an approve arriving meanwhile
    // finds the Checkout over instead of starting an Apply on it.
    // An Apply waiting after its Canary would wait on: it stops instead.
    if (checkout.applying?.resume) this.stopApply(checkout, { reason: endedWhileWaitingReason, endReason: reason, stoppedBy: null });
    if (checkout.applying) await checkout.applying.settled;
    return this.finish(checkout, reason);
  }

  private async finish(checkout: Checkout, reason: EndReason): Promise<CheckoutView> {
    if (checkout.status !== 'active') return this.view(checkout);
    checkout.status = 'ended';
    checkout.endReason = reason;
    this.cancelApprovalRequest(checkout);
    const { channel, connection } = checkout;
    try {
      if (channel) {
        // Keep = basic.nack(requeue), one at a time in queue order: unlike
        // reject or closing with unacked deliveries it uses up no Delivery
        // Budget, and a quorum queue puts them back in the order returned.
        for (const m of checkout.held.values()) channel.nack(m, false, true);
        for (const m of checkout.overflow) channel.nack(m, false, true);
        await channel.close();
      }
    } catch {
      // The channel is already gone: the broker has returned everything.
    }
    // Closing the connection deletes the lock queue: the queue is free again.
    await connection?.close().catch(() => {});
    checkout.held.clear();
    checkout.overflow = [];
    this.release(checkout);
    return this.view(checkout);
  }

  /** Ends every active Checkout (on shutdown). */
  async endAll(): Promise<void> {
    const active = [...this.checkouts.values()].filter((c) => c.status === 'active');
    await Promise.all(active.map((c) => this.end(c.id, 'shutdown')));
  }

  private lockKey(ref: QueueRef): string {
    return JSON.stringify([ref.profile.amqpUrl, ref.vhost, ref.queue]);
  }

  private find(id: string): Checkout {
    const checkout = this.checkouts.get(id);
    if (!checkout) throw new CheckoutError('checkout_not_found', `No Checkout with id "${id}".`);
    return checkout;
  }

  /** The Checkout is over (or never started): frees its queue and its Operator, and forgets it after a while. */
  private release(checkout: Checkout) {
    const lockKey = this.lockKey(checkout);
    if (this.locks.get(lockKey) === checkout) this.locks.delete(lockKey);
    if (this.byOperator.get(checkout.operator.id) === checkout) this.byOperator.delete(checkout.operator.id);
    clearTimeout(checkout.timeLimitTimer);
    clearTimeout(checkout.heartbeatTimer);
    setTimeout(() => this.checkouts.delete(checkout.id), this.endedRetentionMs).unref();
  }

  private startTimers(checkout: Checkout) {
    const left = checkout.endsAt.getTime() - Date.now();
    checkout.timeLimitTimer = setTimeout(async () => {
      await this.hooks.beforeTimeLimitEnd?.(checkout);
      // An Apply attempts no further step; end() then waits for its step in progress.
      this.stopApply(checkout, { reason: TIME_LIMIT_REASON, endReason: 'time-limit', stoppedBy: null });
      await this.end(checkout.id, 'time-limit').catch(() => {});
    }, Math.max(0, left));
    checkout.timeLimitTimer.unref();
    this.armHeartbeat(checkout);
  }

  /**
   * (Re)starts the heartbeat window: the Checkout ends when no heartbeat
   * arrives within it. Suspended while an Apply runs; an Apply that leaves
   * the Checkout active re-arms it.
   */
  private armHeartbeat(checkout: Checkout) {
    clearTimeout(checkout.heartbeatTimer);
    checkout.heartbeatTimer = setTimeout(
      () => this.end(checkout.id, 'no-heartbeat').catch(() => {}),
      checkout.timing.heartbeatWindowMs,
    );
    checkout.heartbeatTimer.unref();
  }

  private markLost(checkout: Checkout, reason: string) {
    if (checkout.status !== 'active') return;
    checkout.status = 'lost';
    checkout.lostReason = reason;
    // A wait for the next paced step ends now; the executor then finds the Checkout not active.
    checkout.applying?.stopped.abort();
    this.cancelApprovalRequest(checkout);
    checkout.held.clear();
    checkout.overflow = [];
    this.release(checkout);
    checkout.connection?.close().catch(() => {});
  }
}
