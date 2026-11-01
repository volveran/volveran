// Clearing up after Replicas that went without stopping, as a job on the Background Leader. Their
// Checkouts are written down as lost and the Audit Entries they left `pending` as `uncertain`,
// soon after their leases run out. Their leases and records go once a Lost Checkout has been
// readable for as long as any Checkout that is over.
//
// Done again on every run until then: nothing here is harmed by that, and a run stopped half
// way is simply finished by the next. Each run reads the time as a lease is written, by the
// real clock, so the leader's test clock does not move it.
import type { AuditStore } from '../audit/audit-store.js';
import type { LeaderJob } from '../leader/background-leader.js';
import { INTERRUPTED_REASON, ownerGoneReason } from './owner-gone.js';

export interface GoneReplicasJobOptions {
  store: Pick<AuditStore, 'replicas' | 'settleInterrupted'>;
  everyMs: number;
  /** How long after a lease runs out its Replica's records stay. */
  keepMs: number;
  log: { info(fields: object, message: string): void; error(fields: object, message: string): void };
}

export function goneReplicasJob({ store, everyMs, keepMs, log }: GoneReplicasJobOptions): LeaderJob {
  let timer: NodeJS.Timeout | undefined;
  let running: Promise<void> | null = null;

  const once = async () => {
    try {
      const now = Date.now();
      for (const record of await store.replicas.checkoutsOfGoneReplicas(now)) {
        // In this order: a run stopped between the two leaves the record to be found again.
        const settled = await store.settleInterrupted(record.id, INTERRUPTED_REASON);
        if (settled > 0) log.info({ checkoutId: record.id, settled }, 'Audit Entries left pending by a Replica that has gone are now uncertain');
        if (record.status === 'active') await store.replicas.updateCheckout(record.id, { status: 'lost', approval: null, lostReason: ownerGoneReason(record.queueType) });
      }
      await store.replicas.removeGoneReplicas(now - keepMs);
    } catch (err) {
      log.error({ err }, 'Could not clear up after Replicas that have gone; trying again');
    }
  };

  return {
    name: 'gone-replicas',
    async start() {
      timer = setInterval(() => {
        running ??= once().finally(() => {
          running = null;
        });
      }, everyMs);
      timer.unref();
    },
    async stop() {
      clearInterval(timer);
      await running;
    },
  };
}
