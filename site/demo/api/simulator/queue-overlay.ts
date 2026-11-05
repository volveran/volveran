// What the simulator changes in a queue list: the live depth of every queue
// its broker has, and who holds it in a Checkout. The rest of the row (type,
// consumers, set-up warnings, depth series) is the read-only data's.
import type { QueueRow } from '../../../../src/shared/queues.js';
import type { DemoBroker } from './broker.js';
import type { Checkouts } from './checkouts.js';

export function withLiveQueues(rows: QueueRow[], vhost: string, sim: { broker: DemoBroker; checkouts: Checkouts }): QueueRow[] {
  return rows.map((row) => {
    const ref = { vhost, queue: row.name };
    if (!sim.broker.queue(ref)) return row;
    return { ...row, approximateMessages: sim.broker.depth(ref), checkedOutBy: sim.checkouts.holderOf(ref) };
  });
}
