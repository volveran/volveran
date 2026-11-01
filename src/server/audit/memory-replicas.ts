// Replicas on SQLite: there is only ever one, so nothing registers and this stays empty in
// a running app. It holds to the same contract as PostgreSQL, in this process's memory.
import type { LiveCheckoutRecord, LiveCheckoutRoute, LiveCheckoutUpdate, NewLiveCheckout, OperatorHolding, ReplicaLeaseRow, ReplicaStore } from './audit-store.js';

export class MemoryReplicaStore implements ReplicaStore {
  private readonly leases = new Map<string, ReplicaLeaseRow>();
  private readonly checkouts = new Map<string, LiveCheckoutRecord>();

  async renewLease(lease: ReplicaLeaseRow): Promise<void> {
    this.leases.set(lease.replicaId, lease);
  }

  async liveAddress(replicaId: string, now: number): Promise<string | null> {
    const lease = this.leases.get(replicaId);
    return lease && lease.expiresAt > now ? lease.forwardingAddress : null;
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
    this.checkouts.set(claim.id, { ...claim, endReason: claim.endReason ?? null, lostReason: claim.lostReason ?? null });
    return null;
  }

  async updateCheckout(id: string, update: LiveCheckoutUpdate): Promise<void> {
    const checkout = this.checkouts.get(id);
    if (!checkout) return;
    const staysLost = checkout.status === 'lost' && update.status === 'active';
    this.checkouts.set(id, {
      ...checkout,
      ...update,
      status: staysLost ? 'lost' : update.status,
      endReason: update.endReason ?? null,
      lostReason: staysLost ? checkout.lostReason : (update.lostReason ?? null),
    });
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

  async checkoutRecord(id: string): Promise<LiveCheckoutRecord | null> {
    return this.checkouts.get(id) ?? null;
  }

  async checkoutsOfGoneReplicas(now: number): Promise<LiveCheckoutRecord[]> {
    return [...this.checkouts.values()].filter((checkout) => {
      const lease = this.leases.get(checkout.ownerReplica);
      return lease !== undefined && lease.expiresAt <= now;
    });
  }

  async removeGoneReplicas(before: number): Promise<number> {
    let removed = 0;
    for (const [replicaId, lease] of this.leases) {
      if (lease.expiresAt > before) continue;
      await this.removeReplica(replicaId);
      removed++;
    }
    return removed;
  }

  async waitingApprovals(now: number): Promise<LiveCheckoutRecord[]> {
    return [...this.checkouts.values()].filter((checkout) => {
      const lease = this.leases.get(checkout.ownerReplica);
      return checkout.status === 'active' && checkout.approval !== null && lease !== undefined && lease.expiresAt > now;
    });
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
