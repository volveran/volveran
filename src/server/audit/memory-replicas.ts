// Replicas on SQLite: there is only ever one, so nothing registers and this stays empty in
// a running app. It holds to the same contract as PostgreSQL, in this process's memory.
import type { LiveCheckoutRoute, LiveCheckoutUpdate, NewLiveCheckout, OperatorHolding, ReplicaLeaseRow, ReplicaStore } from './audit-store.js';

export class MemoryReplicaStore implements ReplicaStore {
  private readonly leases = new Map<string, ReplicaLeaseRow>();
  private readonly checkouts = new Map<string, NewLiveCheckout>();

  async renewLease(lease: ReplicaLeaseRow): Promise<void> {
    this.leases.set(lease.replicaId, lease);
  }

  async removeReplica(replicaId: string): Promise<void> {
    this.leases.delete(replicaId);
    for (const [id, checkout] of this.checkouts) if (checkout.ownerReplica === replicaId) this.checkouts.delete(id);
  }

  async claimCheckout(claim: NewLiveCheckout, now: number): Promise<OperatorHolding | null> {
    for (const checkout of this.checkouts.values()) {
      if (checkout.operator.id !== claim.operator.id || (checkout.status !== 'starting' && checkout.status !== 'active')) continue;
      const lease = this.leases.get(checkout.ownerReplica);
      if (lease && lease.expiresAt > now) return { id: checkout.id, vhost: checkout.vhost, queue: checkout.queue };
      this.checkouts.set(checkout.id, { ...checkout, status: 'lost', approval: null });
    }
    this.checkouts.set(claim.id, claim);
    return null;
  }

  async updateCheckout(id: string, update: LiveCheckoutUpdate): Promise<void> {
    const checkout = this.checkouts.get(id);
    if (!checkout) return;
    this.checkouts.set(id, { ...checkout, ...update, status: checkout.status === 'lost' && update.status === 'active' ? 'lost' : update.status });
  }

  async removeCheckout(id: string): Promise<void> {
    this.checkouts.delete(id);
  }

  async checkoutRoute(id: string, now: number): Promise<LiveCheckoutRoute | null> {
    const checkout = this.checkouts.get(id);
    if (!checkout) return null;
    const lease = this.leases.get(checkout.ownerReplica);
    return { ownerReplica: checkout.ownerReplica, forwardingAddress: lease?.forwardingAddress ?? null, ownerLeaseLive: lease !== undefined && lease.expiresAt > now };
  }

  async activeCheckoutOf(operatorId: string, now: number): Promise<string | null> {
    for (const checkout of this.checkouts.values()) {
      const lease = this.leases.get(checkout.ownerReplica);
      if (checkout.operator.id === operatorId && checkout.status === 'active' && lease && lease.expiresAt > now) return checkout.id;
    }
    return null;
  }
}
