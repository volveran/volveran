// Live Checkout records (#92): what every Replica can read about the Checkouts of the others,
// which is routing information. Held Messages and Decisions stay in the owner's memory.
//
// The manager tells this module of each change without awaiting (ADR 0013). Writes for one
// Checkout run in order, and only the latest state is written; a write that fails is tried
// again after the next lease renewal. Until then only the record's status is behind: where
// to forward to does not change.
import type { LiveCheckoutRecord, LiveCheckoutUpdate, NewLiveCheckout, OperatorHolding, ReplicaStore } from '../audit/audit-store.js';
import type { LiveCheckoutListener } from '../checkout/manager.js';
import type { Checkout } from '../checkout/state.js';
import { approvalSummary, type ApprovalSummary } from '../checkout/view.js';
import { OneAtATime } from '../one-at-a-time.js';
import { remainingMs } from '../triage/checkout-timing.js';
import { ownerGoneReason } from './owner-gone.js';

function stateOf(checkout: Checkout): LiveCheckoutUpdate {
  const { approvalRequest } = checkout;
  return {
    status: checkout.status,
    approval: approvalRequest && checkout.status === 'active' ? approvalSummary({ ...checkout, approvalRequest }) : null,
    endReason: checkout.endReason,
    lostReason: checkout.lostReason,
    queueType: checkout.queueType,
    deliveryLimit: checkout.deliveryLimit,
    readyAtStart: checkout.readyAtStart,
  };
}

export class LiveCheckouts implements LiveCheckoutListener {
  /** What was claimed here and is not yet forgotten. */
  private readonly known = new Set<string>();
  /** The latest state not yet written; null: the record is to go. */
  private readonly unwritten = new Map<string, LiveCheckoutUpdate | null>();
  private readonly writes = new OneAtATime();

  constructor(
    private readonly store: ReplicaStore,
    private readonly replicaId: string,
    private readonly onError: (err: unknown) => void,
  ) {}

  /** Takes the Operator's one place before anything else of a start, or answers what holds it. */
  async claim(checkout: Checkout): Promise<OperatorHolding | null> {
    const record: NewLiveCheckout = {
      id: checkout.id,
      ownerReplica: this.replicaId,
      operator: { id: checkout.operator.id, displayName: checkout.operator.displayName },
      profile: checkout.profile.name,
      vhost: checkout.vhost,
      queue: checkout.queue,
      queueType: checkout.queueType,
      deliveryLimit: checkout.deliveryLimit,
      readyAtStart: checkout.readyAtStart,
      startedAt: checkout.startedAt.getTime(),
      endsAt: checkout.endsAt.getTime(),
      status: 'starting',
      approval: null,
    };
    // Known first: a claim that fails may still have been committed, and `abandoned` removes it.
    this.known.add(checkout.id);
    const holding = await this.writes.run(checkout.id, () => this.store.claimCheckout(record, Date.now()));
    if (holding) this.known.delete(checkout.id);
    return holding;
  }

  /** Every Replica now finds it as it is: a start answers only after this. */
  async started(checkout: Checkout): Promise<void> {
    await this.writes.run(checkout.id, () => this.store.updateCheckout(checkout.id, stateOf(checkout)));
  }

  /** A start failed before it held anything: its claim goes, and the Operator is free when this resolves. */
  async abandoned(id: string): Promise<void> {
    this.forgotten(id);
    await this.written(id);
  }

  changed(checkout: Checkout): void {
    if (this.known.has(checkout.id)) this.write(checkout.id, stateOf(checkout));
  }

  /** Resolves once what was told of Checkout `id` has been written, or tried. Never rejects. */
  written(id: string): Promise<void> {
    return this.writes.run(id, async () => {});
  }

  forgotten(id: string): void {
    if (this.known.has(id)) this.write(id, null);
  }

  /**
   * Whose request about Checkout `id` this is. Null when no other Replica owns it. A live lease
   * means forwarding, and answering that fails is `replica_unreachable`: nothing is known to be
   * lost. With the lease over the owner is taken to be gone: what is left is the record, with
   * a Checkout still going at the last write now lost (a Checkout that had ended stays ended).
   * A record can already be `lost` with no reason, marked so by another start's claim.
   */
  async ownerOf(id: string): Promise<{ address: string } | { gone: LiveCheckoutRecord } | null> {
    const route = await this.store.checkoutRoute(id, Date.now());
    if (!route || route.ownerReplica === this.replicaId) return null;
    if (route.forwardingAddress !== null && route.ownerLeaseLive) return { address: route.forwardingAddress };
    const record = await this.store.checkoutRecord(id);
    if (!record) return null;
    if (record.status === 'ended') return { gone: record };
    return { gone: { ...record, status: 'lost', approval: null, lostReason: record.lostReason ?? ownerGoneReason(record.queueType) } };
  }

  /** The id of an Operator's active Checkout on a Replica that is alive. */
  activeCheckoutOf(operatorId: string): Promise<string | null> {
    return this.store.activeCheckoutOf(operatorId, Date.now());
  }

  /** The Approvals waiting on other Replicas, except the Operator's own. A record's times are as of the request, so they are measured here. */
  async waitingElsewhere(approverId: string): Promise<ApprovalSummary[]> {
    const now = new Date();
    const records = await this.store.waitingApprovals(now.getTime());
    return records.flatMap(({ ownerReplica, operator, approval }) =>
      approval && ownerReplica !== this.replicaId && operator.id !== approverId
        ? [{ ...approval, waitingMs: Math.max(0, now.getTime() - new Date(approval.requestedAt).getTime()), remainingMs: remainingMs(new Date(approval.endsAt), now) }]
        : [],
    );
  }

  /**
   * Whether another Replica is still running Checkout `id`. Its record's status is written
   * behind, so a record may say running a moment after the end, but never the reverse.
   */
  async runningElsewhere(id: string): Promise<boolean> {
    const owner = await this.store.runningOwner(id, Date.now());
    return owner !== null && owner !== this.replicaId;
  }

  /** Tries again what could not be written. Never rejects. */
  async writeAgain(): Promise<void> {
    await Promise.all([...this.unwritten.keys()].map((id) => this.flush(id)));
  }

  /** Resolves when no write is in progress. */
  settled(): Promise<void> {
    return this.writes.settled();
  }

  private write(id: string, state: LiveCheckoutUpdate | null): void {
    this.unwritten.set(id, state);
    void this.flush(id);
  }

  /** `run` answers as its work does, and this work never rejects. */
  private flush(id: string): Promise<void> {
    return this.writes.run(id, async () => {
      if (!this.unwritten.has(id)) return;
      const state = this.unwritten.get(id)!;
      try {
        if (state) await this.store.updateCheckout(id, state);
        else await this.store.removeCheckout(id);
        if (this.unwritten.get(id) === state) this.unwritten.delete(id);
        if (!state) this.known.delete(id);
      } catch (err) {
        this.onError(err);
      }
    });
  }
}
