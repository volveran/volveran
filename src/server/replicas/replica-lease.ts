// A Replica's lease in the shared store: while it is renewed, other Replicas take this one
// to be alive, and know where to forward to it. Nothing else is leased here.
import type { ReplicaStore } from '../audit/audit-store.js';

export interface ReplicaLeaseTiming {
  renewEveryMs: number;
  /** How long a renewal holds. Several renewals fit in it, so one failure does not lose the lease. */
  holdsForMs: number;
}

export const DEFAULT_REPLICA_LEASE_TIMING: ReplicaLeaseTiming = { renewEveryMs: 5_000, holdsForMs: 15_000 };

export interface ReplicaLeaseOptions {
  store: ReplicaStore;
  replicaId: string;
  forwardingAddress: string;
  timing: ReplicaLeaseTiming;
  /** After each renewal in the background, whether it succeeded or not. Must not reject. */
  afterRenewal(): Promise<void>;
  onError(err: unknown): void;
}

export class ReplicaLease {
  private timer: NodeJS.Timeout | undefined;
  private renewing: Promise<void> | null = null;

  constructor(private readonly options: ReplicaLeaseOptions) {}

  /** Takes the lease, rejecting if it cannot, and keeps renewing it. */
  async start(): Promise<void> {
    await this.renew();
    this.timer = setInterval(() => {
      this.renewing ??= this.renewInBackground().finally(() => {
        this.renewing = null;
      });
    }, this.options.timing.renewEveryMs);
    this.timer.unref();
  }

  async stop(): Promise<void> {
    clearInterval(this.timer);
    await this.renewing;
  }

  private renew(): Promise<void> {
    const { store, replicaId, forwardingAddress, timing } = this.options;
    return store.renewLease({ replicaId, forwardingAddress, expiresAt: Date.now() + timing.holdsForMs });
  }

  private async renewInBackground(): Promise<void> {
    try {
      await this.renew();
    } catch (err) {
      this.options.onError(err);
    }
    await this.options.afterRenewal();
  }
}
