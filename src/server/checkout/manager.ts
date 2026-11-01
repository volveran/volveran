// Checkout manager (ADR 0006): the registry and lifecycle of every Checkout.
// Starting one opens its connection, takes the lock queue and collects the
// Messages (open.ts); Apply runs in apply.ts. The manager keeps the
// Checkouts, the in-process locks, the timers, and how a Checkout ends.
//
// Ending a Checkout nack-requeues every held Message one at a time in queue
// order, then the overflow, and on a quorum queue waits for the queue to take
// them back before closing the channel, up to a time limit: that keeps the
// order and costs no Delivery Budget (return-messages.ts, ADR 0006). A closed channel or
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
// a Lost Checkout and the Apply's last step wins. So does every first-wins
// section here: it claims its state before any audit store call, and none of
// them makes one (ADR 0013). The Apply's own store calls happen in steps that
// have already been claimed, and count a step as settled before its outcome is written.
// An export claims nothing and is no such section: it only reads, from a copy taken
// before its store call, so what starts or ends meanwhile changes nothing in it, as
// when it starts while the download is written.
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
// most one (checked before the broker's lock, so the holder is known exactly). Across Replicas,
// the Operator's limit is a claim on the Live Checkout records, and the queue's is the lock queue.
import { randomUUID } from 'node:crypto';
import type { Operator } from '../operator.js';
import type { QueueAccess } from '../profile-access.js';
import { queueRefOf, type BrokerProfile, type QueueRef } from '../profiles.js';
import { STOP_REASONS } from '../apply/stop-reasons.js';
import type { ApplyOptions, MessageOutcome, RuleActing } from '../apply/types.js';
import type { CheckoutLimits } from '../triage/checkout-collection.js';
import type { Filter } from '../triage/filters.js';
import { DEFAULT_CHECKOUT_TIMING, remainingMs, type CheckoutTiming } from '../triage/checkout-timing.js';
import { applyOutlastsCheckout, replayRateFor } from '../triage/replay-rate.js';
import { messageDetail, type HeldForBadge, type MessageDetail } from '../triage/message-view.js';
import type { RuleSchedulerTestHooks } from '../replay-rules/rule-clock.js';
import type { RuleBadge } from '../../shared/replay-rules.js';
import { replayTrail } from '../audit/replay-trail.js';
import type { AuditStore, LiveCheckoutRecord, OperatorHolding, ProfileScope } from '../audit/audit-store.js';
import { diedAgain } from '../triage/died-again.js';
import type { CheckoutQueueType } from '../../shared/checkout.js';
import type { Role } from '../../shared/roles.js';
import { runApply } from './apply.js';
import { canaryFor } from './canary.js';
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
import { closeCheckoutConnection, openCheckout, type StartOptions } from './open.js';
import { returnMessages } from './return-messages.js';
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
  /** Replaces how long a Checkout's end waits for a quorum queue to take its Messages back (returnWaitMs). */
  returnWaitMs?: number;
  /** The Replay Rule scheduler's clock and "run a pass now" (replay-rules/rule-clock.ts); the server hands them to it. */
  ruleScheduler?: RuleSchedulerTestHooks;
}

/** Each held Message's running Replay Rule's badge, in the order given (replay-rules/rules.ts); null when no running rule matches it. */
export type RuleBadgesOf = (checkout: Checkout, held: readonly HeldForBadge[]) => Promise<Array<RuleBadge | null>>;

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

/**
 * Told of each Checkout, for the records other Replicas read. `started` is awaited before
 * the start answers; the others are called inside first-wins sections and must not make them wait.
 */
export interface LiveCheckoutListener {
  /** Awaited before a start touches the broker: the Operator's Checkout on any Replica, if they have one. */
  claim(checkout: Checkout): Promise<OperatorHolding | null>;
  started(checkout: Checkout): Promise<void>;
  /** Awaited when a start fails before it held anything, so the Operator can start again anywhere at once. */
  abandoned(id: string): Promise<void>;
  /** Awaited before an end answers, so no Replica still finds the Checkout active after it. Never rejects. */
  written(id: string): Promise<void>;
  changed(checkout: Checkout): void;
  forgotten(id: string): void;
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
  ruleBadges?: RuleBadgesOf;
  /** Rule badges could not be read; the Checkout is shown without them. */
  onRuleBadgesError?(err: unknown): void;
  /** An Apply running in the background failed unexpectedly (its steps report their own failures); the Checkout still ends. */
  onApplyError?(checkoutId: string, err: unknown): void;
  /** An Apply ended with these outcomes, one per Message of the Checkout. */
  onApplyEnded?(checkout: Checkout, outcomes: readonly MessageOutcome[]): void;
  /** A Checkout's end stopped waiting for its queue to take its Messages back; the channel closes anyway. */
  onReturnWaitRanOut?(checkout: Checkout, waited: { returned: number; waitedMs: number }): void;
  /** Left out when this Replica is on its own. */
  liveCheckouts?: LiveCheckoutListener;
}

/**
 * Who stops or continues an Apply: its Checkout's owner, or the Operator who
 * approved it (applyActedOnBy).
 */
export interface ApplyActor {
  operator: Operator;
  as: 'owner' | 'approver';
}

/** What stopped an Apply first, as a refused stop or Continue says it. */
function stopperText(stop: ApplyStop): string {
  return stop.stoppedBy ?? (stop.endReason === 'time-limit' ? 'the time limit' : 'the Checkout ending');
}

export const DEFAULT_ENDED_RETENTION_MS = 15 * 60_000;

/** A Checkout holding nothing yet, `active`. */
function blankCheckout(ref: QueueRef, fields: Pick<Checkout, 'id' | 'operator' | 'startedAt' | 'endsAt' | 'timing' | 'requireApproval' | 'limits'>): Checkout {
  return {
    ...ref,
    ...fields,
    // Set from the credentials the connection opens with (open.ts).
    brokerUser: '',
    queueType: 'classic',
    deliveryLimit: null,
    deadLetterExchange: false,
    timeLimitTimer: undefined,
    heartbeatTimer: undefined,
    status: 'active',
    approvalRequest: null,
    approvalClosed: null,
    rejection: null,
    lostReason: null,
    ownerGone: false,
    endReason: null,
    readyAtStart: 0,
    limitedBy: null,
    connection: undefined,
    channel: undefined,
    onlyConsumer: false,
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
}

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
    const checkout = blankCheckout(ref, {
      id: randomUUID(),
      operator,
      startedAt,
      endsAt: new Date(startedAt.getTime() + this.timing.timeLimitMs),
      timing: this.timing,
      requireApproval: (this.options.enforceApproval ?? false) && target.profile.protected && target.profile.requireApproval,
      limits:
        options.maxMessages === undefined
          ? this.options.limits
          : { ...this.options.limits, maxMessages: Math.min(options.maxMessages, this.options.limits.maxMessages) },
    });
    this.locks.set(lockKey, checkout);
    this.byOperator.set(operator.id, checkout);
    try {
      const holding = await this.options.liveCheckouts?.claim(checkout);
      if (holding) throw operatorHasCheckout(operator.displayName, holding);
      await openCheckout(checkout, target, options, {
        onLost: (reason) => this.markLost(checkout, reason),
        afterLock: this.hooks.afterLock,
        afterCollectWait: this.hooks.afterCollectWait,
        afterCollect: this.hooks.afterCollect,
      });
    } catch (err) {
      this.release(checkout);
      await closeCheckoutConnection(checkout);
      await this.options.liveCheckouts?.abandoned(checkout.id);
      throw err;
    }
    try {
      await this.findDiedAgain(checkout, options.auditScope);
      await this.options.liveCheckouts?.started(checkout);
    } catch (err) {
      // It holds Messages by now, so they go back as at any end. If it was lost
      // during the search that has been done, and the queue may be someone else's.
      await this.finish(checkout, 'start-failed');
      throw err;
    }
    this.checkouts.set(checkout.id, checkout);
    if (checkout.status === 'active') this.startTimers(checkout);
    return this.view(checkout);
  }

  /** Whether this Replica knows Checkout `id`, which makes it the Owner Replica. */
  owns(id: string): boolean {
    return this.checkouts.has(id);
  }

  /**
   * Another Replica owned this Checkout and has gone (`record`, already saying lost or ended):
   * from here on this Replica answers for it, as an owner does for a Checkout that is over,
   * through the same routes and checks, and forgets it after the same while. It holds nothing,
   * and takes neither queue nor Operator. Nothing awaits, so of two requests one adds it.
   */
  answerForGoneOwner(record: LiveCheckoutRecord, profile: BrokerProfile): void {
    if (this.checkouts.has(record.id)) return;
    const ref: QueueRef = { profile, vhost: record.vhost, queue: record.queue };
    const checkout = blankCheckout(ref, {
      id: record.id,
      operator: record.operator,
      startedAt: new Date(record.startedAt),
      endsAt: new Date(record.endsAt),
      timing: this.timing,
      requireApproval: false,
      limits: this.options.limits,
    });
    checkout.queueType = record.queueType;
    checkout.deliveryLimit = record.deliveryLimit;
    checkout.readyAtStart = record.readyAtStart;
    checkout.status = record.status === 'ended' ? 'ended' : 'lost';
    checkout.endReason = record.endReason;
    checkout.lostReason = record.lostReason;
    checkout.ownerGone = checkout.status === 'lost';
    this.checkouts.set(checkout.id, checkout);
    this.release(checkout);
  }

  /** The browser still shows the Checkout: it stays until the next heartbeat window passes. */
  heartbeat(id: string): CheckoutView {
    const checkout = this.find(id);
    // While an Apply runs the heartbeat window is suspended, except while it waits after a Canary.
    if (checkout.status === 'active' && (!checkout.applying || checkout.applying.continueAfterCanary)) checkout.heartbeatTimer?.refresh();
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

  async message(id: string, handle: number): Promise<MessageDetail> {
    const checkout = this.find(id);
    const m = checkout.held.get(handle);
    if (!m) throw new CheckoutError('message_not_found', `Checkout ${id} holds no Message with handle ${handle}.`);
    const diedAgain = checkout.diedAgain.get(handle) ?? null;
    const detail = messageDetail(handle, m, queueInfo(checkout));
    const [rule] = await this.ruleBadges(checkout, [{ delivery: m, diedAgainCount: diedAgain?.count ?? 0 }]);
    return { ...detail, diedAgain, rule: rule ?? null };
  }

  /**
   * `view` with each row's rule badge; routes/checkouts.ts adds them to every
   * response. Apart from the methods that answer a view, because this reads the store:
   * they settle first-wins sections with no await, and what they did stands even
   * if the badges cannot be read.
   */
  async withRuleBadges(view: CheckoutView): Promise<CheckoutView> {
    const checkout = this.checkouts.get(view.id);
    if (!checkout) return view;
    const rows = view.messages.flatMap((row) => {
      const delivery = checkout.held.get(row.handle);
      return delivery ? [{ row, delivery, diedAgainCount: checkout.diedAgain.get(row.handle)?.count ?? 0 }] : [];
    });
    const badges = await this.ruleBadges(checkout, rows);
    const byHandle = new Map(rows.map(({ row }, i) => [row.handle, badges[i] ?? null]));
    return { ...view, messages: view.messages.map((row) => ({ ...row, rule: byHandle.get(row.handle) ?? null })) };
  }

  private async ruleBadges(checkout: Checkout, held: readonly HeldForBadge[]): Promise<Array<RuleBadge | null>> {
    try {
      return (await this.options.ruleBadges?.(checkout, held)) ?? [];
    } catch (err) {
      this.options.onRuleBadgesError?.(err);
      return [];
    }
  }

  private view(checkout: Checkout): CheckoutView {
    return checkoutView(checkout);
  }

  /** Recognises the held Messages that are Died Again, once, as they are held (their replay ids never change). */
  private async findDiedAgain(checkout: Checkout, auditScope: ProfileScope | undefined): Promise<void> {
    const trail = replayTrail(this.options.audit, auditScope);
    for (const [handle, m] of checkout.held) {
      const found = await diedAgain(m.properties.headers, trail);
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
   * refusals (rateFor). `role` is the Applying Operator's Role on the
   * profile, recorded in each Audit Entry. `rate` is the request's Replay
   * Rate as sent (left out: the profile's default). `canary` is the
   * request's Canary as sent (canary.ts, canaryFor).
   */
  apply(id: string, role: Role, rate?: unknown, canary?: unknown): CheckoutView {
    const checkout = this.find(id);
    this.assertCanApply(checkout);
    if (checkout.approvalRequest) throw awaitingApproval(checkout, 'only an approver can Apply it');
    if (this.view(checkout).applyConfirmation.approvalRequired) throw approvalRequired(checkout);
    const canaryHandle = canaryFor(checkout, canary);
    return this.startApply(checkout, { role, approver: null, rate: this.rateFor(checkout, rate), canary: canaryHandle, rule: null });
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
    this.startApply(checkout, { role: 'operator', approver: null, rate, canary: null, rule });
    await checkout.applying?.settled;
    return this.view(checkout);
  }

  /**
   * The Replay Rate an Apply of the Checkout runs at, from the request's
   * `requested` rate: replayRateFor's refusals (triage/replay-rate.ts), and
   * 409 `apply_would_outlast_checkout` when the Replay and Move steps at
   * that rate would outlast the time left.
   */
  private rateFor(checkout: Checkout, requested: unknown): number | null {
    const rate = replayRateFor(requested, checkout.profile, { pacedSteps: pacedSteps(checkout) });
    this.assertFitsTimeLeft(checkout, rate);
    return rate;
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
   * Replay Rate's refusals (rateFor). `canary` is the request's
   * Canary as sent, frozen too: the approved Apply starts with it (same
   * refusals as for an Apply, canaryFor).
   */
  requestApproval(id: string, role: Role, rate?: unknown, canary?: unknown): CheckoutView {
    const checkout = this.find(id);
    this.assertCanApply(checkout);
    if (checkout.approvalRequest) throw awaitingApproval(checkout, 'Approval is already requested');
    if (!this.view(checkout).applyConfirmation.approvalRequired) throw approvalNotRequired(checkout);
    const frozenCanary = canaryFor(checkout, canary);
    const frozenRate = this.rateFor(checkout, rate);
    checkout.approvalRequest = { requestedAt: new Date(), role, rate: frozenRate, canary: frozenCanary };
    checkout.approvalClosed = null;
    checkout.rejection = null;
    this.options.liveCheckouts?.changed(checkout);
    return this.view(checkout);
  }

  /** The owner withdraws the request: the Decisions can change again. Throws `not_awaiting_approval`. */
  withdrawApproval(id: string): CheckoutView {
    const checkout = this.find(id);
    this.takeApprovalRequest(checkout, { how: 'withdrawn' });
    return this.view(checkout);
  }

  /** How many Checkouts are active now, and how many of those wait for Approval. */
  counts(): { active: number; waitingApproval: number } {
    const active = [...this.checkouts.values()].filter((c) => c.status === 'active');
    return { active: active.length, waitingApproval: active.filter((c) => c.approvalRequest !== null).length };
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
    return this.startApply(checkout, { role: request.role, approver, rate: request.rate, canary: request.canary, rule: null });
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
    this.options.liveCheckouts?.changed(checkout);
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
  private startApply(checkout: Checkout, options: ApplyOptions): CheckoutView {
    clearTimeout(checkout.heartbeatTimer);
    const running: RunningApply = {
      settled: Promise.resolve(),
      stop: null,
      stopController: new AbortController(),
      continueAfterCanary: null,
    };
    checkout.applying = running;
    running.settled = this.carryOutApply(checkout, running, options);
    return this.view(checkout);
  }

  private async carryOutApply(checkout: Checkout, running: RunningApply, options: ApplyOptions) {
    const { approver } = options;
    try {
      const { startedAt, outcomes } = await runApply(checkout, {
        apply: { ...options, approver: approver && { id: approver.id, displayName: approver.displayName } },
        audit: this.options.audit,
        stopReason: () => running.stop?.reason ?? null,
        stopSignal: running.stopController.signal,
        beforeStep: this.hooks.beforeApplyStep,
        canaryWait: {
          waitStarted: (continueAfterCanary) => this.canaryWaitStarted(checkout, running, continueAfterCanary),
          waitEnded: () => this.canaryWaitEnded(checkout, running),
        },
      });
      checkout.lastApply = { at: startedAt.toISOString(), outcomes, approvedBy: approver?.displayName ?? null };
      this.options.onApplyEnded?.(checkout, outcomes);
    } catch (err) {
      this.options.onApplyError?.(checkout.id, err);
    }
    // Still `applying` until every Message not done is back in the queue; an
    // end() that waited for this Apply then finds the Checkout already ended.
    await this.finish(checkout, running.stop?.endReason ?? 'applied').catch(() => {});
    checkout.applying = null;
  }

  /**
   * `by` stops the Checkout's Apply: the step in progress finishes, and
   * every step left is reported not attempted, "stopped by" them, and goes
   * back to the queue with the Checkout's end. Who may: applyActedOnBy.
   * Throws 409 `apply_not_running` when nothing is left to stop: no Apply
   * runs, it has attempted its last step, the Checkout was lost, or a stop
   * (the time limit, another Operator) came first. Nothing awaits, so this
   * and those are serialised per Checkout.
   */
  stopApplyBy(id: string, by: ApplyActor): CheckoutView {
    const { checkout } = this.applyActedOnBy(id, by, applyNotRunning);
    if (checkout.applyProgress?.view().remaining === 0) throw applyNotRunning(checkout, 'it has attempted every step');
    const name = by.operator.displayName;
    this.stopApply(checkout, { reason: STOP_REASONS.stoppedBy(name), endReason: 'applied', stoppedBy: name });
    return this.view(checkout);
  }

  /**
   * `by` lets the Apply waiting after its Canary carry out every remaining
   * step, at its Replay Rate; allowed before the Watch Window ends, which
   * ends the watch. Who may: applyActedOnBy. Throws 409 `apply_not_waiting`
   * unless the Apply waits after a Canary and nothing stopped it first.
   * Nothing awaits, so this and a stop are serialised per Checkout.
   */
  continueApplyBy(id: string, by: ApplyActor): CheckoutView {
    const { checkout, running } = this.applyActedOnBy(id, by, applyNotWaiting);
    const continueAfterCanary = running.continueAfterCanary;
    if (!continueAfterCanary) throw applyNotWaiting(checkout, 'it is not waiting after a Canary');
    this.canaryWaitEnded(checkout, running);
    continueAfterCanary();
    return this.view(checkout);
  }

  /**
   * The Apply running on Checkout `id`, for `by` to stop or continue. The
   * caller has checked that `by.operator` owns the Checkout, or (`as:
   * 'approver'`) holds the `approve` capability; here the approver must be
   * the one who approved this Apply (403 `not_checkout_owner` otherwise).
   * Throws `refuse` (409) when no Apply runs, the Checkout was lost, or a
   * stop came first.
   */
  private applyActedOnBy(
    id: string,
    by: ApplyActor,
    refuse: (checkout: Checkout, why: string) => CheckoutError,
  ): { checkout: Checkout; running: RunningApply } {
    const checkout = this.find(id);
    if (by.as === 'approver' && !this.approvedBy(id, by.operator)) throw notApplyApprover(id);
    const running = checkout.applying;
    if (!running) throw refuse(checkout, 'no Apply is running');
    if (checkout.status === 'lost') throw refuse(checkout, 'the Checkout was lost, so its Apply attempts no further step');
    if (running.stop) throw refuse(checkout, `${stopperText(running.stop)} already stopped it`);
    return { checkout, running };
  }

  /** The Apply waits after its Canary, the Checkout still active: its heartbeat window runs again. */
  private canaryWaitStarted(checkout: Checkout, running: RunningApply, continueAfterCanary: () => void) {
    if (running.continueAfterCanary) return;
    running.continueAfterCanary = continueAfterCanary;
    if (checkout.status === 'active') this.armHeartbeat(checkout);
  }

  /** The wait after the Canary is over (Continue, a stop): the heartbeat window is suspended again. */
  private canaryWaitEnded(checkout: Checkout, running: RunningApply) {
    running.continueAfterCanary = null;
    clearTimeout(checkout.heartbeatTimer);
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
    running.stopController.abort();
    if (stop.stoppedBy && checkout.applyProgress) checkout.applyProgress.stoppedBy = stop.stoppedBy;
  }

  /**
   * Starts an NDJSON export of the held Messages matching `filter` (every
   * one when null) and records its Audit Entry (export.ts). Changes nothing
   * on the broker. Throws `checkout_not_active` on a Checkout that is over
   * or lost, `apply_in_progress` while it is Applied, both as of the start of the
   * call. `role` is the exporting Operator's Role, recorded in the Audit Entry.
   */
  async exportMessages(id: string, filter: Filter | null, role: Role): Promise<CheckoutExport> {
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
    if (checkout.applying?.continueAfterCanary) {
      this.stopApply(checkout, { reason: STOP_REASONS.checkoutEndedWhileWaiting, endReason: reason, stoppedBy: null });
    }
    if (checkout.applying) await checkout.applying.settled;
    return this.finish(checkout, reason);
  }

  private async finish(checkout: Checkout, reason: EndReason): Promise<CheckoutView> {
    if (checkout.status !== 'active') return this.view(checkout);
    checkout.status = 'ended';
    checkout.endReason = reason;
    this.cancelApprovalRequest(checkout);
    this.options.liveCheckouts?.changed(checkout);
    const { channel } = checkout;
    try {
      if (channel) {
        await returnMessages(checkout, channel, {
          waitMs: this.hooks.returnWaitMs,
          onWaitRanOut: (waited) => this.options.onReturnWaitRanOut?.(checkout, waited),
        });
        await channel.close();
      }
    } catch {
      // The channel is already gone: the broker has returned everything.
    }
    // With the lock queue deleted, the queue is free again.
    await closeCheckoutConnection(checkout);
    checkout.held.clear();
    checkout.overflow = [];
    this.release(checkout);
    await this.options.liveCheckouts?.written(checkout.id);
    return this.view(checkout);
  }

  /**
   * This Replica's lease has run out, so other Replicas report its Checkouts lost: it makes
   * that true, closing their connections, and the broker returns their Messages. An Apply
   * attempts no further step, as on any Lost Checkout. Nothing awaits.
   */
  loseAll(reason: (queueType: CheckoutQueueType) => string): void {
    for (const checkout of [...this.locks.values()]) this.markLost(checkout, reason(checkout.queueType));
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
    setTimeout(() => {
      this.checkouts.delete(checkout.id);
      this.options.liveCheckouts?.forgotten(checkout.id);
    }, this.endedRetentionMs).unref();
  }

  private startTimers(checkout: Checkout) {
    const left = checkout.endsAt.getTime() - Date.now();
    checkout.timeLimitTimer = setTimeout(async () => {
      await this.hooks.beforeTimeLimitEnd?.(checkout);
      // An Apply attempts no further step; end() then waits for its step in progress.
      this.stopApply(checkout, { reason: STOP_REASONS.timeLimit, endReason: 'time-limit', stoppedBy: null });
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
    checkout.applying?.stopController.abort();
    this.cancelApprovalRequest(checkout);
    this.options.liveCheckouts?.changed(checkout);
    checkout.held.clear();
    checkout.overflow = [];
    this.release(checkout);
    checkout.connection?.close().catch(() => {});
  }
}
