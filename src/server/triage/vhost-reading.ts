// One reading of a vhost's dead-letter set-up: reads the management API once
// and answers with the queue rows and the dead-letter edges. The queue list,
// the sampler and the Dead-letter Map all read a vhost through here.
//
// Depth and consumer counts come from management statistics, which lag the
// broker by a few seconds: the rows call the depth approximate.
import type { ManagementClient } from '../management.js';
import type { BrokerProfile } from '../profiles.js';
import type { QueueRow, SetupWarningCounts } from '../../shared/queues.js';
import { isCanaryWatchQueue } from './canary-watch.js';
import { checkoutHolders, isLockQueue } from './checkout-lock.js';
import { deadLetterEdges, type DeadLetterEdge } from './dead-letter-edges.js';
import { arrangeQueues, checkoutAvailability, sourcesFromEdges } from './queue-list.js';
import { countSetupWarnings, setupWarnings, type VhostTopology } from './setup-checks.js';

export interface VhostReading {
  /** Every queue of the vhost, Volverán's own (Checkout lock and Canary watch) left out, in the queue list's order. */
  queues: QueueRow[];
  /** Keep the `routes` edges to follow the Messages. */
  edges: DeadLetterEdge[];
  /** Every queue of the vhost counts. */
  setupWarningCounts: SetupWarningCounts;
}

/** The management API calls a reading makes. */
export type VhostReader = Pick<ManagementClient, 'listQueues' | 'listBindings' | 'listExchanges'>;

export async function readVhost(source: { profile: Pick<BrokerProfile, 'defaultQueueFilter'>; management: VhostReader }, vhost: string): Promise<VhostReading> {
  const { profile, management } = source;
  const [allQueues, bindings, exchanges] = await Promise.all([
    management.listQueues(vhost),
    management.listBindings(vhost),
    management.listExchanges(vhost),
  ]);
  // Checkout lock queues are Volverán's own: not listed, but they say who holds which queue.
  const holders = checkoutHolders(allQueues);
  // A Canary's watch queue is bound to the dead-letter exchange, but it is no destination of the set-up.
  const queues = allQueues.filter((q) => !isLockQueue(q.name) && !isCanaryWatchQueue(q.name));
  const topology: VhostTopology = {
    exchanges: new Map(exchanges.map((e) => [e.name, e])),
    bindings: bindings.filter((b) => b.destinationType !== 'queue' || !isCanaryWatchQueue(b.destination)),
  };
  const edges = deadLetterEdges(queues, topology);
  const arrangeOptions = { defaultQueueFilter: profile.defaultQueueFilter, deadLetterSources: sourcesFromEdges(edges) };

  const warningsByName = new Map(arrangeQueues(queues, arrangeOptions).map((q) => [q.name, setupWarnings(q, topology)]));
  const rows = queues.map((q) => ({
    name: q.name,
    type: q.type,
    approximateMessages: q.messages,
    consumers: q.consumers,
    checkout: checkoutAvailability(q.type),
    checkedOutBy: holders.get(q.name) ?? null,
  }));
  return {
    queues: arrangeQueues(rows, arrangeOptions).map((row): QueueRow => ({ ...row, setupWarnings: warningsByName.get(row.name)! })),
    edges,
    setupWarningCounts: countSetupWarnings(warningsByName.values()),
  };
}
