// The leader lease on SQLite: in memory, as one Replica needs no more, so a restart
// is its own leader at once. The SQLite stores check a fence synchronously, right
// before their write, so nothing can come between the check and the write.
import { LeaderLeaseLost, type LeaderLeaseGrant, type LeaderLeaseStore, type LeaseFence } from './audit-store.js';

export class MemoryLeaderLease implements LeaderLeaseStore {
  private holder: string | null = null;
  private term = 0;
  private expiresAt = 0;

  async claim(holder: string, now: number, durationMs: number): Promise<LeaderLeaseGrant | null> {
    if (this.holder !== holder) {
      if (this.holder !== null && this.expiresAt > now) return null;
      this.holder = holder;
      this.term += 1;
    }
    this.expiresAt = now + durationMs;
    return { holder, term: this.term, expiresAt: this.expiresAt };
  }

  async release(holder: string): Promise<void> {
    if (this.holder === holder) this.holder = null;
  }

  async currentHolder(): Promise<string | null> {
    return this.holder;
  }

  /** Throws unless the lease is still held as `fence` says; no fence, no check. */
  check(fence: LeaseFence | undefined): void {
    if (fence && (fence.holder !== this.holder || fence.term !== this.term)) throw new LeaderLeaseLost();
  }
}
