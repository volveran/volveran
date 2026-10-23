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
// Apply (ADR 0001) ends the Checkout ('applied') once it has run: what is
// still held (Keep, failed, not attempted) goes back to the queue in order.
// While Apply runs, nothing else ends the Checkout: the time limit, the
// heartbeat window and an Operator's end wait for it. Only the broker can
// cut it short (Lost Checkout).
//
// In-process, an Operator (keyed by `Operator.id`) has at most one active Checkout, and a queue at
// most one (checked before the broker's lock, so the holder is known exactly).
import { randomUUID } from 'node:crypto';
import type { Operator } from '../operator.js';
import type { QueueRef } from '../profiles.js';
import type { CheckoutLimits } from '../triage/checkout-collection.js';
import { DEFAULT_CHECKOUT_TIMING, type CheckoutTiming } from '../triage/checkout-timing.js';
import { messageDetail, type MessageDetail } from '../triage/message-view.js';
import type { MessageOutcome } from '../apply/types.js';
import type { AuditStore } from '../audit/store.js';
import { runApply } from './apply.js';
import { applyInProgress, CheckoutError, checkoutNotActive, inCheckout, notCheckoutOwner, operatorHasCheckout } from './errors.js';
import { openCheckout, type StartOptions } from './open.js';
import type { Checkout, EndReason } from './state.js';
import { queueInfo, view, type CheckoutView } from './view.js';

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
  /** A Checkout reached its time limit; next it ends itself. */
  beforeTimeLimitEnd?(ref: QueueRef): Promise<void>;
  /** An Apply step's `pending` Audit Entry is committed; next the step touches the broker (e.g. the ack of a Discard). */
  beforeApplyStep?(entryId: number): Promise<void>;
}

export interface CheckoutManagerOptions {
  /** Where Apply writes its Audit Entries. */
  audit: AuditStore;
  limits: CheckoutLimits;
  /** Time limit, heartbeat window and quorum backstop margin (default DEFAULT_CHECKOUT_TIMING). */
  timing?: CheckoutTiming;
  /** How long an ended or lost Checkout stays readable before it is forgotten. */
  endedRetentionMs?: number;
  testHooks?: CheckoutTestHooks;
}

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

  async start(ref: QueueRef, operator: Operator, options: StartOptions = {}): Promise<CheckoutView> {
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
      queueType: 'classic',
      deliveryLimit: null,
      deadLetterExchange: false,
      startedAt,
      timing: this.timing,
      expiresAt: new Date(startedAt.getTime() + this.timing.timeLimitMs),
      timeLimitTimer: undefined,
      heartbeatTimer: undefined,
      status: 'active',
      lostReason: null,
      endReason: null,
      readyAtStart: 0,
      limits: this.options.limits,
      limitedBy: null,
      connection: undefined,
      channel: undefined,
      held: new Map(),
      overflow: [],
      heldBytes: 0,
      decisions: new Map(),
      applying: null,
      lastApply: null,
    };
    this.locks.set(lockKey, checkout);
    this.byOperator.set(operator.id, checkout);
    try {
      await openCheckout(checkout, options, {
        onLost: (reason) => this.markLost(checkout, reason),
        afterLock: this.hooks.afterLock,
        afterCollectWait: this.hooks.afterCollectWait,
      });
    } catch (err) {
      this.release(checkout);
      await checkout.connection?.close().catch(() => {});
      throw err;
    }
    this.checkouts.set(checkout.id, checkout);
    if (checkout.status === 'active') this.startTimers(checkout);
    return view(checkout);
  }

  /** The browser still shows the Checkout: it stays until the next heartbeat window passes. */
  heartbeat(id: string): CheckoutView {
    const checkout = this.find(id);
    if (checkout.status === 'active') checkout.heartbeatTimer?.refresh();
    return view(checkout);
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
    return view(this.find(id));
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
    return c && this.checkouts.has(c.id) ? view(c) : null;
  }

  message(id: string, handle: number): MessageDetail {
    const checkout = this.find(id);
    const m = checkout.held.get(handle);
    if (!m) throw new CheckoutError('message_not_found', `Checkout ${id} holds no Message with handle ${handle}.`);
    return messageDetail(handle, m, queueInfo(checkout));
  }

  /**
   * Carries out every Decision of the Checkout (ADR 0001), then ends it:
   * Messages whose Decision is Keep, failed or was not attempted go back to
   * the queue in order. Returns the outcome for each Message. Throws
   * `checkout_not_active` on a Checkout that is over or lost.
   */
  async apply(id: string): Promise<{ checkout: CheckoutView; outcomes: MessageOutcome[] }> {
    const checkout = this.find(id);
    if (checkout.status !== 'active') throw checkoutNotActive(checkout, 'nothing can be Applied');
    if (checkout.applying) throw applyInProgress(checkout);
    const { startedAt, outcomes } = await runApply(checkout, {
      audit: this.options.audit,
      beforeStep: this.hooks.beforeApplyStep,
    });
    checkout.lastApply = { at: startedAt.toISOString(), outcomes };
    // Straight to finish (no await first): an end() that waited for this
    // Apply then finds the Checkout already ended as 'applied'.
    await this.finish(checkout, 'applied');
    return { checkout: view(checkout), outcomes };
  }

  /** Ends the Checkout: every held Message goes back to the queue untouched, in its original order. */
  async end(id: string, reason: EndReason = 'operator'): Promise<CheckoutView> {
    const checkout = this.find(id);
    // An Apply in progress finishes first (it ends the Checkout itself), so
    // a done step is never returned and no step is cut short.
    await checkout.applying?.catch(() => {});
    return this.finish(checkout, reason);
  }

  private async finish(checkout: Checkout, reason: EndReason): Promise<CheckoutView> {
    if (checkout.status !== 'active') return view(checkout);
    checkout.status = 'ended';
    checkout.endReason = reason;
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
    return view(checkout);
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
    const left = checkout.expiresAt.getTime() - Date.now();
    checkout.timeLimitTimer = setTimeout(async () => {
      await this.hooks.beforeTimeLimitEnd?.(checkout);
      await this.end(checkout.id, 'time-limit').catch(() => {});
    }, Math.max(0, left));
    checkout.heartbeatTimer = setTimeout(
      () => this.end(checkout.id, 'no-heartbeat').catch(() => {}),
      checkout.timing.heartbeatWindowMs,
    );
    checkout.timeLimitTimer.unref();
    checkout.heartbeatTimer.unref();
  }

  private markLost(checkout: Checkout, reason: string) {
    if (checkout.status !== 'active') return;
    checkout.status = 'lost';
    checkout.lostReason = reason;
    checkout.held.clear();
    checkout.overflow = [];
    this.release(checkout);
    checkout.connection?.close().catch(() => {});
  }
}
