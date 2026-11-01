// Live Checkout records (#92): what every Replica can read about the Checkouts of the others,
// which is routing information. Held Messages and Decisions stay in the owner's memory.
//
// The manager tells this module of each change without awaiting (ADR 0013). Writes for one
// Checkout run in order, and only the latest state is written; a write that fails is tried
// again after the next lease renewal. Until then only the record's status is behind: where
// to forward to does not change.
import type { LiveCheckoutUpdate, NewLiveCheckout, ReplicaStore } from '../audit/audit-store.js';
import type { LiveCheckoutListener } from '../checkout/manager.js';
import type { Checkout } from '../checkout/state.js';
import { approvalSummary } from '../checkout/view.js';
import { OneAtATime } from '../one-at-a-time.js';
import { replicaUnreachable } from './forwarding.js';

function stateOf(checkout: Checkout): LiveCheckoutUpdate {
  const { approvalRequest } = checkout;
  return {
    status: checkout.status,
    approval: approvalRequest && checkout.status === 'active' ? approvalSummary({ ...checkout, approvalRequest }) : null,
  };
}

export class LiveCheckouts implements LiveCheckoutListener {
  /** What was added here and is not yet forgotten: a Checkout that never finished starting has no record. */
  private readonly known = new Set<string>();
  /** The latest state not yet written; null: the record is to go. */
  private readonly unwritten = new Map<string, LiveCheckoutUpdate | null>();
  private readonly writes = new OneAtATime();

  constructor(
    private readonly store: ReplicaStore,
    private readonly replicaId: string,
    private readonly onError: (err: unknown) => void,
  ) {}

  /** Writes the record, which every Replica then finds: a start answers only after this. */
  async started(checkout: Checkout): Promise<void> {
    const record: NewLiveCheckout = {
      id: checkout.id,
      ownerReplica: this.replicaId,
      operator: { id: checkout.operator.id, displayName: checkout.operator.displayName },
      profile: checkout.profile.name,
      vhost: checkout.vhost,
      queue: checkout.queue,
      ...stateOf(checkout),
    };
    this.known.add(checkout.id);
    try {
      await this.writes.run(checkout.id, () => this.store.addCheckout(record));
    } catch (err) {
      this.known.delete(checkout.id);
      throw err;
    }
  }

  changed(checkout: Checkout): void {
    if (this.known.has(checkout.id)) this.write(checkout.id, stateOf(checkout));
  }

  forgotten(id: string): void {
    if (this.known.has(id)) this.write(id, null);
  }

  /** Where to forward a request about Checkout `id`; null when no other Replica owns it. */
  async ownerAddress(id: string): Promise<string | null> {
    const route = await this.store.checkoutRoute(id, Date.now());
    if (!route || route.ownerReplica === this.replicaId) return null;
    if (route.forwardingAddress === null || !route.ownerLeaseLive) throw replicaUnreachable();
    return route.forwardingAddress;
  }

  /** The id of an Operator's active Checkout on a Replica that is alive. */
  activeCheckoutOf(operatorId: string): Promise<string | null> {
    return this.store.activeCheckoutOf(operatorId, Date.now());
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
