// Retention, as a job on the Background Leader: evicts Discarded bodies past their
// limits, and removes old notification outcomes, Samples and sampling runs, when the
// job starts and on a schedule. Its writes name the lease, so a former leader's are refused.
import { LeaderLeaseLost, type AuditStore, type LeaseFence } from '../audit/audit-store.js';
import type { BodyRetention } from '../audit/body-retention.js';
import type { RuleClock } from '../replay-rules/rule-clock.js';
import type { LeaderJob } from './background-leader.js';

export interface RetentionJobOptions {
  store: Pick<AuditStore, 'evictBodies' | 'notifications' | 'history'>;
  retention: BodyRetention;
  historyRetentionMs: number;
  clock: RuleClock;
  log: { info(fields: object, message: string): void; error(err: unknown, message: string): void };
  /** After each run, for the store's size in the metrics. Must not reject. */
  afterRun(): Promise<void>;
}

export function retentionJob({ store, retention, historyRetentionMs, clock, log, afterRun }: RetentionJobOptions): LeaderJob {
  let timer: { cancel(): void } | null = null;
  let running: Promise<void> | null = null;

  const step = async (failure: string, work: () => Promise<void>) => {
    try {
      await work();
    } catch (err) {
      if (err instanceof LeaderLeaseLost) log.info({}, 'Retention wrote nothing: this Replica is no longer the Background Leader');
      else log.error(err, failure);
    }
  };

  const once = async (fence: LeaseFence) => {
    const now = clock.now();
    const cutoff = now.getTime() - historyRetentionMs;
    await step('Retention could not evict Discarded Message bodies', async () => {
      const { evicted } = await store.evictBodies({ now, ...retention }, fence);
      if (evicted > 0) log.info({ evicted }, 'Retention evicted Discarded Message bodies');
    });
    await step('Retention could not remove old notification outcomes', async () => {
      await store.notifications.removeOlderThan(new Date(cutoff), fence);
    });
    await step('Retention could not remove old Samples', async () => {
      const { samples } = await store.history.removeOlderThan(cutoff, fence);
      if (samples > 0) log.info({ samples }, 'Retention removed old Samples');
    });
    await afterRun();
  };

  // Never rejects. A run still going when the next is due is left to finish.
  const run = (fence: LeaseFence) => {
    running ??= once(fence).finally(() => {
      running = null;
    });
    return running;
  };

  const schedule = (fence: LeaseFence) => {
    timer = clock.setTimer(() => {
      schedule(fence);
      void run(fence);
    }, retention.intervalMs);
  };

  return {
    name: 'retention',
    async start(fence) {
      await run(fence);
      schedule(fence);
    },
    async stop() {
      timer?.cancel();
      timer = null;
      await running;
    },
  };
}
