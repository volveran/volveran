// The demo's Checkouts, as src/server/checkout/manager.ts runs them: one
// active Checkout per Operator and per queue, a time limit and a heartbeat
// window, Decisions staged until Apply, an Apply in the background that ends
// the Checkout, and every Message without an applied Decision returned to the
// queue when it ends. Ended Checkouts stay readable for the page's life.
import { ApplyProgressTracker } from '../../../../src/server/apply/progress.js';
import { STOP_REASONS } from '../../../../src/server/apply/stop-reasons.js';
import { applyConfirmationFor } from '../../../../src/server/triage/apply-confirmation.js';
import { DEFAULT_CHECKOUT_TIMING } from '../../../../src/server/triage/checkout-timing.js';
import type {
  AppliedResult,
  CanaryConfirmation,
  CanaryView,
  CheckoutHolder,
  CheckoutLimits,
  CheckoutView,
  DiedAgain,
  EndReason,
  MessageDetail,
} from '../../../../src/shared/checkout.js';
import { summaryText, type ActionDecision, type Decision, type DecisionKind, type DecisionSummaryLine, type MoveDestination } from '../../../../src/shared/decisions.js';
import type { Filter } from '../../../../src/shared/filters.js';
import { isReplayRate, MAX_REPLAY_RATE, MIN_REPLAY_RATE, pacedDurationMs } from '../../../../src/shared/replay-rate.js';
import { DemoApiError } from '../router.js';
import { executeApply, type ApplyStep, type CanaryHooks } from './apply.js';
import type { AuditLog } from './audit-log.js';
import type { BrokerMessage, DemoBroker, QueueRef } from './broker.js';
import { exportFilename, exportLine } from './export.js';
import { matchesFilter } from './filters.js';
import { messageDetail, messageSummary, replayOrigin, type QueueInfo } from './message-view.js';
import type { ProfileSettings } from './profile-settings.js';

const LIMITS: CheckoutLimits = { maxMessages: 1000, maxBytes: 100 * 1024 * 1024 };

interface ApplyStop {
  reason: string;
  endReason: EndReason;
  stoppedBy: string | null;
}

interface RunningApply {
  settled: Promise<void>;
  stop: ApplyStop | null;
  stopController: AbortController;
  /** Set while the Apply waits after its Canary (#150): carries out the rest. */
  continueAfterCanary: (() => void) | null;
}

/** What starts an Apply, beyond the confirmation the route checks. */
export interface ApplyOptions {
  rate: number | null;
  /** The Canary's handle, or null for none (#150 picks it, canaryFor). */
  canary: number | null;
}

export interface DemoCheckout extends QueueRef {
  id: string;
  profile: ProfileSettings;
  info: QueueInfo;
  operator: string;
  startedAt: Date;
  endsAt: Date;
  status: 'active' | 'ended';
  endReason: EndReason | null;
  readyAtStart: number;
  limitedBy: CheckoutView['limitedBy'];
  /** Held Messages by handle, in queue order; emptied when the Checkout ends. */
  held: Map<number, BrokerMessage>;
  heldBytes: number;
  /** Decisions other than Keep; a handle without one is Keep. */
  decisions: Map<number, ActionDecision>;
  /** Held Messages that are Died Again (#150 fills it at start). */
  diedAgain: Map<number, DiedAgain>;
  applying: RunningApply | null;
  applyProgress: ApplyProgressTracker | null;
  lastApply: AppliedResult | null;
  /** The Canary of the Apply (#150). */
  canary: CanaryView | null;
  timeLimitTimer?: ReturnType<typeof setTimeout>;
  heartbeatTimer?: ReturnType<typeof setTimeout>;
}

export interface CheckoutsDeps {
  broker: DemoBroker;
  audit: AuditLog;
  operator: string;
  /** The Operator's active Checkout changed (GET /session's `checkoutId`). */
  activeChanged(id: string | null): void;
  /**
   * The Canary hooks of an Apply (#150, the server's checkout/canary.ts);
   * none by default.
   */
  canaryHooks?(checkout: DemoCheckout, handle: number, running: { stopSignal: AbortSignal; waitStarted(continueAfterCanary: () => void): void; waitEnded(): void }): CanaryHooks;
}

export class Checkouts {
  readonly #checkouts = new Map<string, DemoCheckout>();
  readonly #timing = DEFAULT_CHECKOUT_TIMING;

  constructor(private readonly deps: CheckoutsDeps) {}

  /** Starts a Checkout of the queue; throws as the server does (checkout/errors.ts). */
  start(profile: ProfileSettings, ref: QueueRef, options: { overrideConsumers: boolean }): CheckoutView {
    const { broker, operator } = this.deps;
    const { vhost, queue } = ref;
    const spec = broker.queue(ref);
    if (!spec) throw new DemoApiError(404, 'queue_not_found', `Queue "${queue}" does not exist in vhost "${vhost}".`);
    if (spec.type === 'stream') {
      throw new DemoApiError(
        409,
        'queue_not_checkoutable',
        'Stream queues cannot be checked out: a stream keeps its Messages after they are read, so there is nothing to hold and settle one by one. Only classic and quorum queues can be triaged.',
      );
    }
    const mine = this.#active().find((c) => c.operator === operator);
    if (mine) {
      throw new DemoApiError(
        409,
        'operator_has_checkout',
        `${operator} already has an active Checkout of queue "${mine.queue}" in vhost "${mine.vhost}". End it before starting another.`,
        { checkoutId: mine.id, vhost: mine.vhost, queue: mine.queue },
      );
    }
    const holder = this.holderOf(ref);
    if (holder) {
      throw new DemoApiError(
        409,
        'checkout_in_progress',
        `Queue "${queue}" in vhost "${vhost}" is already checked out: ${holder.operator} has held it since ${holder.since}. Only one Checkout per queue can exist at a time; try again once it has ended.`,
        { holder },
      );
    }
    const consumers = spec.consumers ?? 0;
    if (consumers > 0 && !options.overrideConsumers) {
      const n = consumers === 1 ? '1 consumer is' : `${consumers} consumers are`;
      throw new DemoApiError(
        409,
        'queue_has_consumers',
        `${n} reading queue "${queue}" in vhost "${vhost}". A Checkout would compete with them for Messages, and they keep receiving the ones the Checkout does not hold. Stop them first, or start the Checkout with the consumer override to go ahead anyway.`,
        { consumers },
      );
    }

    const startedAt = new Date();
    const readyAtStart = broker.ready(ref);
    const held = new Map<number, BrokerMessage>();
    let heldBytes = 0;
    let limitedBy: CheckoutView['limitedBy'] = readyAtStart > LIMITS.maxMessages ? 'messages' : null;
    for (const m of broker.hold(ref, LIMITS.maxMessages)) {
      if (held.size > 0 && heldBytes + m.content.length > LIMITS.maxBytes) {
        limitedBy = 'bytes';
        broker.release(ref, [m]);
        continue;
      }
      held.set(held.size + 1, m);
      heldBytes += m.content.length;
    }
    const checkout: DemoCheckout = {
      id: crypto.randomUUID(),
      profile,
      vhost,
      queue,
      info: { type: spec.type, deliveryLimit: spec.deliveryLimit ?? null, deadLetterExchange: spec.deadLetterExchange !== undefined },
      operator,
      startedAt,
      endsAt: new Date(startedAt.getTime() + this.#timing.timeLimitMs),
      status: 'active',
      endReason: null,
      readyAtStart,
      limitedBy,
      held,
      heldBytes,
      decisions: new Map(),
      diedAgain: new Map(),
      applying: null,
      applyProgress: null,
      lastApply: null,
      canary: null,
    };
    this.#checkouts.set(checkout.id, checkout);
    this.deps.activeChanged(checkout.id);
    this.#startTimers(checkout);
    return this.#view(checkout);
  }

  get(id: string): CheckoutView {
    return this.#view(this.#find(id));
  }

  /** The browser still shows the Checkout; suspended while an Apply runs, except while it waits after a Canary. */
  heartbeat(id: string): CheckoutView {
    const checkout = this.#find(id);
    if (checkout.status === 'active' && (!checkout.applying || checkout.applying.continueAfterCanary)) this.#armHeartbeat(checkout);
    return this.#view(checkout);
  }

  message(id: string, handle: number): MessageDetail {
    const checkout = this.#find(id);
    const m = checkout.held.get(handle);
    if (!m) throw new DemoApiError(404, 'message_not_found', `Checkout ${id} holds no Message with handle ${handle}.`);
    return { ...messageDetail(handle, m, checkout.info), diedAgain: checkout.diedAgain.get(handle) ?? null, rule: null };
  }

  /** The handles of the held Messages matching `filter`, in Checkout order. */
  matching(id: string, filter: Filter): number[] {
    const checkout = this.#find(id);
    return [...checkout.held.entries()].filter(([, m]) => matchesFilter(filter, m)).map(([handle]) => handle);
  }

  /**
   * The held Messages matching `filter` (every one when null) as NDJSON, as
   * the server's checkout/export.ts makes it, with one `export` Audit Entry.
   * Only reads: no Message or Decision changes.
   */
  exportMessages(id: string, filter: Filter | null): { filename: string; count: number; text: string } {
    const checkout = this.#find(id);
    if (checkout.status !== 'active') throw notActive(checkout, 'its Messages can no longer be exported');
    if (checkout.applying) throw applyInProgress(checkout);
    const picked = [...checkout.held.entries()].map(([handle, m], i) => ({ position: i + 1, m, decision: checkout.decisions.get(handle) ?? { kind: 'keep' as const } }));
    const lines = picked.filter(({ m }) => filter === null || matchesFilter(filter, m));
    const at = new Date();
    const entryId = this.deps.audit.record({
      at: at.toISOString(),
      operatorId: checkout.operator,
      operatorName: checkout.operator,
      role: 'admin',
      approverId: null,
      approverName: null,
      brokerUser: checkout.profile.brokerUser,
      profile: checkout.profile.name,
      vhost: checkout.vhost,
      queue: checkout.queue,
      messageId: null,
      action: 'export',
      reason: null,
      destination: null,
      checkoutId: checkout.id,
      restoreOf: null,
      replayId: null,
      filter,
      messageCount: lines.length,
      rate: null,
      rule: null,
      rulePassId: null,
      canary: false,
      message: null,
    });
    const text = lines.map(({ position, m, decision }) => `${JSON.stringify(exportLine(position, m, checkout.info, decision))}\n`).join('');
    this.deps.audit.setOutcome(entryId, 'done');
    return { filename: exportFilename(checkout.profile.name, checkout.queue, at), count: lines.length, text };
  }

  /**
   * Gives `decision` to the Messages `handles` (Keep clears theirs); those
   * that cannot take it keep their Decision and come back with the reason.
   */
  stage(id: string, handles: readonly number[], decision: Decision): { checkout: CheckoutView; rejected: Array<{ handle: number; reason: string }> } {
    const checkout = this.#find(id);
    if (checkout.status !== 'active') throw notActive(checkout, 'its Messages can no longer take Decisions');
    if (checkout.applying) throw applyInProgress(checkout);
    if (decision.kind === 'move') this.#assertMoveDestination(checkout, decision.destination);
    const rejected: Array<{ handle: number; reason: string }> = [];
    for (const handle of new Set(handles)) {
      const message = checkout.held.get(handle);
      if (!message) {
        rejected.push({ handle, reason: `This Checkout holds no Message with handle ${handle}.` });
        continue;
      }
      const origin = decision.kind === 'replay' ? replayOrigin(message.properties.headers) : null;
      if (origin && !origin.ok) rejected.push({ handle, reason: origin.reason });
      else if (decision.kind === 'keep') checkout.decisions.delete(handle);
      else checkout.decisions.set(handle, decision);
    }
    return { checkout: this.#view(checkout), rejected };
  }

  /** The Replay Rate an Apply runs at: the request's, else the profile's default (#150 adds its maximum). */
  rateFor(id: string, requested: unknown): number | null {
    const { profile } = this.#find(id);
    if (requested !== undefined && requested !== null && !isReplayRate(requested)) {
      throw new DemoApiError(400, 'invalid_request', `"rate" must be a number of Messages per second from ${MIN_REPLAY_RATE} to ${MAX_REPLAY_RATE}, or left out.`);
    }
    return (requested as number | null | undefined) ?? profile.replayRate.default;
  }

  /**
   * Starts carrying out the Decisions in the background; the Checkout ends
   * when it has run. Returns the Checkout `applying`.
   */
  apply(id: string, options: ApplyOptions): CheckoutView {
    const checkout = this.#find(id);
    if (checkout.status !== 'active') throw notActive(checkout, 'nothing can be Applied');
    if (checkout.applying) throw applyInProgress(checkout);
    clearTimeout(checkout.heartbeatTimer);
    const running: RunningApply = { settled: Promise.resolve(), stop: null, stopController: new AbortController(), continueAfterCanary: null };
    checkout.applying = running;
    running.settled = this.#carryOut(checkout, running, options);
    return this.#view(checkout);
  }

  /** The Operator stops the Apply: every step not yet attempted falls back to Keep. */
  stopApply(id: string): CheckoutView {
    const checkout = this.#find(id);
    const running = checkout.applying;
    if (!running) throw applyNotRunning(checkout, 'no Apply is running');
    if (running.stop) throw applyNotRunning(checkout, `${running.stop.stoppedBy ?? 'the Checkout ending'} already stopped it`);
    if (checkout.applyProgress?.view().remaining === 0) throw applyNotRunning(checkout, 'it has attempted every step');
    const name = this.deps.operator;
    this.#stopApply(checkout, { reason: STOP_REASONS.stoppedBy(name), endReason: 'applied', stoppedBy: name });
    return this.#view(checkout);
  }

  /** The Operator continues an Apply waiting after its Canary (#150). */
  continueApply(id: string): CheckoutView {
    const checkout = this.#find(id);
    const running = checkout.applying;
    const cannot = (why: string) => new DemoApiError(409, 'apply_not_waiting', `The Apply of Checkout ${checkout.id} cannot continue: ${why}.`);
    if (!running) throw cannot('no Apply is running');
    if (running.stop) throw cannot(`${running.stop.stoppedBy ?? 'the Checkout ending'} already stopped it`);
    const go = running.continueAfterCanary;
    if (!go) throw cannot('it is not waiting after a Canary');
    running.continueAfterCanary = null;
    clearTimeout(checkout.heartbeatTimer);
    go();
    return this.#view(checkout);
  }

  /** Ends the Checkout: an Apply in progress finishes first; every held Message goes back to the queue. */
  async end(id: string, reason: EndReason = 'operator'): Promise<CheckoutView> {
    const checkout = this.#find(id);
    if (checkout.applying?.continueAfterCanary) {
      this.#stopApply(checkout, { reason: STOP_REASONS.checkoutEndedWhileWaiting, endReason: reason, stoppedBy: null });
    }
    if (checkout.applying) await checkout.applying.settled;
    return this.#finish(checkout, reason);
  }

  /** Who holds the queue in an active Checkout, for the queue list; null when nobody does. */
  holderOf(ref: QueueRef): CheckoutHolder | null {
    const c = this.#active().find((x) => x.vhost === ref.vhost && x.queue === ref.queue);
    return c ? { operator: c.operator, since: c.startedAt.toISOString() } : null;
  }

  async #carryOut(checkout: DemoCheckout, running: RunningApply, options: ApplyOptions): Promise<void> {
    const handles = [...checkout.held.keys()];
    const steps: ApplyStep[] = [];
    const kept: number[] = [];
    for (const handle of handles) {
      const decision = checkout.decisions.get(handle);
      if (decision) steps.push({ handle, decision });
      else kept.push(handle);
    }
    const startedAt = new Date();
    const progress = new ApplyProgressTracker(steps.length, startedAt, options.rate);
    checkout.applyProgress = progress;
    const { broker, audit } = this.deps;
    try {
      const outcomes = await executeApply({
        steps,
        kept,
        messages: new Map(checkout.held),
        target: {
          profile: checkout.profile.name,
          vhost: checkout.vhost,
          queue: checkout.queue,
          checkoutId: checkout.id,
          operator: checkout.operator,
          role: 'admin',
          brokerUser: checkout.profile.brokerUser,
        },
        broker,
        audit,
        rate: options.rate,
        stopReason: () => running.stop?.reason ?? (checkout.status === 'active' ? null : STOP_REASONS.checkoutNotActive),
        stopSignal: running.stopController.signal,
        onStep: (o) => {
          if (o.status !== 'kept') progress.record(o.status);
        },
        onDone: (handle) => {
          checkout.held.delete(handle);
          checkout.decisions.delete(handle);
        },
        ...(options.canary !== null &&
          this.deps.canaryHooks && {
            canary: this.deps.canaryHooks(checkout, options.canary, {
              stopSignal: running.stopController.signal,
              waitStarted: (go) => {
                running.continueAfterCanary = go;
                if (checkout.status === 'active') this.#armHeartbeat(checkout);
              },
              waitEnded: () => {
                running.continueAfterCanary = null;
                clearTimeout(checkout.heartbeatTimer);
              },
            }),
          }),
      });
      checkout.lastApply = { at: startedAt.toISOString(), outcomes, approvedBy: null };
    } finally {
      this.#finish(checkout, running.stop?.endReason ?? 'applied');
      checkout.applying = null;
    }
  }

  #stopApply(checkout: DemoCheckout, stop: ApplyStop) {
    const running = checkout.applying;
    if (!running || running.stop) return;
    running.stop = stop;
    running.stopController.abort();
    if (stop.stoppedBy && checkout.applyProgress) checkout.applyProgress.stoppedBy = stop.stoppedBy;
  }

  /** Over: every Message still held goes back to the queue in order (Keep), the queue and the Operator are free. */
  #finish(checkout: DemoCheckout, reason: EndReason): CheckoutView {
    if (checkout.status !== 'active') return this.#view(checkout);
    checkout.status = 'ended';
    checkout.endReason = reason;
    clearTimeout(checkout.timeLimitTimer);
    clearTimeout(checkout.heartbeatTimer);
    this.deps.broker.release(checkout, checkout.held.values());
    checkout.held.clear();
    checkout.heldBytes = 0;
    this.deps.activeChanged(null);
    return this.#view(checkout);
  }

  #startTimers(checkout: DemoCheckout) {
    checkout.timeLimitTimer = setTimeout(() => {
      this.#stopApply(checkout, { reason: STOP_REASONS.timeLimit, endReason: 'time-limit', stoppedBy: null });
      void this.end(checkout.id, 'time-limit');
    }, Math.max(0, checkout.endsAt.getTime() - Date.now()));
    this.#armHeartbeat(checkout);
  }

  #armHeartbeat(checkout: DemoCheckout) {
    clearTimeout(checkout.heartbeatTimer);
    checkout.heartbeatTimer = setTimeout(() => void this.end(checkout.id, 'no-heartbeat'), this.#timing.heartbeatWindowMs);
  }

  #assertMoveDestination(checkout: DemoCheckout, destination: MoveDestination) {
    const { vhost, queue } = checkout;
    if ('queue' in destination) {
      if (destination.queue === queue) {
        throw new DemoApiError(422, 'decision_not_allowed', `The Messages are already in "${queue}": Move them to another queue, or Keep them.`);
      }
      if (!this.deps.broker.queue({ vhost, queue: destination.queue })) {
        throw new DemoApiError(
          422,
          'decision_not_allowed',
          `There is no queue "${destination.queue}" in vhost "${vhost}": a Move can only go to an existing queue of the same vhost.`,
        );
      }
    } else if (!this.deps.broker.hasExchange(vhost, destination.exchange)) {
      throw new DemoApiError(
        422,
        'decision_not_allowed',
        `There is no exchange "${destination.exchange}" in vhost "${vhost}": a Move can only go to an existing exchange of the same vhost.`,
      );
    }
  }

  #active(): DemoCheckout[] {
    return [...this.#checkouts.values()].filter((c) => c.status === 'active');
  }

  #find(id: string): DemoCheckout {
    const checkout = this.#checkouts.get(id);
    if (!checkout) throw new DemoApiError(404, 'checkout_not_found', `No Checkout with id "${id}".`);
    return checkout;
  }

  #view(c: DemoCheckout): CheckoutView {
    const handles = [...c.held.keys()];
    const decisionOf = (h: number): Decision => c.decisions.get(h) ?? { kind: 'keep' };
    const decisionSummary = summarize(handles.map(decisionOf));
    const paced = handles.filter((h) => ['replay', 'move'].includes(decisionOf(h).kind)).length;
    return {
      id: c.id,
      profile: c.profile.name,
      protectedProfile: c.profile.protected,
      vhost: c.vhost,
      queue: c.queue,
      queueType: c.info.type,
      operator: c.operator,
      startedAt: c.startedAt.toISOString(),
      timeLimitMs: this.#timing.timeLimitMs,
      endsAt: c.endsAt.toISOString(),
      remainingMs: c.status === 'active' ? Math.max(0, c.endsAt.getTime() - Date.now()) : 0,
      heartbeatWindowMs: this.#timing.heartbeatWindowMs,
      status: c.applying ? 'applying' : c.status,
      lostReason: null,
      ownerGone: false,
      endReason: c.endReason,
      readyAtStart: c.readyAtStart,
      heldCount: c.held.size,
      heldBytes: c.heldBytes,
      limits: LIMITS,
      limitedBy: c.limitedBy,
      deliveryLimit: c.info.deliveryLimit,
      messages: [...c.held.entries()].map(([handle, m]) => {
        const origin = replayOrigin(m.properties.headers);
        return {
          ...messageSummary(handle, m, c.info),
          decision: decisionOf(handle),
          replay: origin.ok ? { available: true } : { available: false, reason: origin.reason, ...(origin.suggestedMove && { suggestedMove: origin.suggestedMove }) },
          diedAgain: c.diedAgain.get(handle) ?? null,
          rule: null,
        };
      }),
      diedAgainCount: handles.filter((h) => c.diedAgain.has(h)).length,
      decisionSummary,
      decisionSummaryText: summaryText(decisionSummary),
      applyConfirmation: {
        ...applyConfirmationFor({ protectedProfile: c.profile.protected, requireApproval: false, actionCount: c.decisions.size }),
        replayRate: { ...c.profile.replayRate },
        estimatedDurationMs: pacedDurationMs(paced, c.profile.replayRate.default),
        canary: this.#canaryConfirmation(c),
      },
      approvalRequest: null,
      rejection: null,
      applyProgress: c.applyProgress?.view() ?? null,
      lastApply: c.lastApply,
      canary: c.canary,
    };
  }

  /** The Messages that may be the Canary (Decision Replay, in Checkout order); watchable when their origin queue dead-letters. */
  #canaryConfirmation(c: DemoCheckout): CanaryConfirmation {
    const candidates: CanaryConfirmation['candidates'] = [];
    for (const [handle, m] of c.held) {
      if (c.decisions.get(handle)?.kind !== 'replay') continue;
      const origin = replayOrigin(m.properties.headers);
      const dlx = origin.ok ? this.deps.broker.queue({ vhost: c.vhost, queue: origin.queue })?.deadLetterExchange : undefined;
      candidates.push({ handle, watch: dlx ? { watchable: true } : { watchable: false, reason: 'Where this Message dead-letters is not known.' } });
    }
    const { watchWindowMs, requiredAbove } = c.profile.canary;
    return { watchWindowMs, requiredAbove, required: requiredAbove !== null && candidates.length > requiredAbove, candidates };
  }
}

const SUMMARY_ORDER: DecisionKind[] = ['discard', 'replay', 'move', 'keep'];

function destinationKey(d: MoveDestination): string {
  return 'queue' in d ? `0 ${d.queue}` : `1 ${d.exchange}\u0000${d.routingKey}`;
}

/** Messages per Decision, Moves per destination, Keep last (src/server/triage/decisions.ts, summarizeDecisions). */
function summarize(decisions: Decision[]): DecisionSummaryLine[] {
  const counts = new Map<string, DecisionSummaryLine>();
  for (const decision of decisions) {
    const k = decision.kind === 'move' ? `move:${destinationKey(decision.destination)}` : decision.kind;
    const line: DecisionSummaryLine =
      counts.get(k) ?? (decision.kind === 'move' ? { kind: 'move', destination: decision.destination, count: 0 } : { kind: decision.kind, count: 0 });
    line.count++;
    counts.set(k, line);
  }
  return [...counts.values()].sort(
    (a, b) =>
      SUMMARY_ORDER.indexOf(a.kind) - SUMMARY_ORDER.indexOf(b.kind) ||
      (a.kind === 'move' && b.kind === 'move' ? destinationKey(a.destination).localeCompare(destinationKey(b.destination)) : 0),
  );
}

function notActive(c: DemoCheckout, consequence: string): DemoApiError {
  return new DemoApiError(
    409,
    'checkout_not_active',
    `The Checkout of "${c.queue}" in vhost "${c.vhost}" is over: its Messages are back in the queue. So ${consequence}. Start a new Checkout.`,
    { status: c.status, lostReason: null },
  );
}

function applyInProgress(c: DemoCheckout): DemoApiError {
  return new DemoApiError(409, 'apply_in_progress', `Checkout ${c.id} is being Applied. Wait for that Apply to finish.`);
}

function applyNotRunning(c: DemoCheckout, why: string): DemoApiError {
  return new DemoApiError(409, 'apply_not_running', `No Apply of Checkout ${c.id} can be stopped: ${why}.`);
}
