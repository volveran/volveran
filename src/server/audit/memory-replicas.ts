// Replicas on SQLite: there is only ever one, so nothing registers and this stays empty in
// a running app. It holds to the same contract as PostgreSQL, in this process's memory.
import type { LiveCheckoutRoute, LiveCheckoutUpdate, NewLiveCheckout, ReplicaLeaseRow, ReplicaStore } from './audit-store.js';

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

  async addCheckout(checkout: NewLiveCheckout): Promise<void> {
    this.checkouts.set(checkout.id, checkout);
  }

  async updateCheckout(id: string, update: LiveCheckoutUpdate): Promise<void> {
    const checkout = this.checkouts.get(id);
    if (checkout) this.checkouts.set(id, { ...checkout, ...update });
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

  async runningOwner(id: string, now: number): Promise<string | null> {
    const checkout = this.checkouts.get(id);
    const lease = checkout && this.leases.get(checkout.ownerReplica);
    return checkout && lease && lease.expiresAt > now && (checkout.status === 'active' || checkout.status === 'applying') ? checkout.ownerReplica : null;
  }
}
