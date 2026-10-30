// The queue list's small depth charts: the last 24 hours of each listed
// dead-letter queue, read only from the audit store, never the broker. The gaps
// are the profile's, read once for the whole list.
import { downsample } from './downsample.js';
import { historyGaps } from './gaps.js';
import type { HistoryRouteDeps } from '../routes/history.js';
import type { DepthSeries } from '../../shared/history.js';
import type { QueueRow } from '../../shared/queues.js';

/** A small chart cannot show more, and every listed queue sends this many. */
const MAX_POINTS = 96;
const DAY_MS = 24 * 60 * 60 * 1000;

export function depthSeriesOf(
  { history, clock, intervalMs }: HistoryRouteDeps,
  profile: string,
  vhost: string,
  queues: readonly QueueRow[],
): QueueRow[] {
  const to = clock.now().getTime();
  const from = to - DAY_MS;
  const gaps: DepthSeries['gaps'] = historyGaps(history.runsAround(profile, from, to), { from, to, now: to, intervalMs }).map(
    (g) => ({ from: g.from, to: g.to }),
  );
  return queues.map((queue) => {
    if (!queue.deadLetterQueue) return queue;
    const samples = downsample(history.samples({ profile, vhost, queue: queue.name }, from, to), MAX_POINTS);
    return { ...queue, depthSeries: { from, to, points: samples.map((s) => [s.at, s.depth]), gaps } };
  });
}
