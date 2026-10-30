// The arrivals counter counts what Alerts count: arrivals the depth has borne
// out, so management lag's false spikes never reach a counter that cannot go back.
import { describe, expect, it } from 'vitest';
import { QueueMetrics } from '../../src/server/metrics/queues.js';
import type { LatestSample } from '../../src/server/history/sampler.js';

const sample = (previousDepth: number | null, depth: number, takenOut = 0): LatestSample => ({
  profile: 'p',
  vhost: '/',
  queue: 'a.dlq',
  at: new Date(),
  depth,
  previousDepth,
  takenOut,
  estimatedArrivals: previousDepth === null ? null : Math.max(0, depth - previousDepth + takenOut),
  setupWarnings: [],
});

function counterAfter(...samples: LatestSample[]): number | undefined {
  const metrics = new QueueMetrics(() => ({ profiles: [] }));
  for (const s of samples) metrics.runFinished({ run: { profile: 'p', at: s.at, ok: true, errorCode: null }, samples: [s] });
  return metrics.families().find((f) => f.name === 'volveran_dead_letter_queue_estimated_arrived_messages_total')!.series[0]?.value ?? undefined;
}

describe('volveran_dead_letter_queue_estimated_arrived_messages_total', () => {
  it('has no series while arrivals are unknown', () => {
    expect(counterAfter(sample(null, 10))).toBeUndefined();
  });

  it('counts a rise in depth at once', () => {
    expect(counterAfter(sample(null, 10), sample(10, 15))).toBe(5);
  });

  it('does not count a take-out whose drop in depth shows a Sample later', () => {
    expect(counterAfter(sample(null, 10), sample(10, 10, 10), sample(10, 0))).toBe(0);
  });

  it('counts arrivals a take-out hid, one Sample late', () => {
    expect(counterAfter(sample(null, 10), sample(10, 10, 10))).toBe(0);
    expect(counterAfter(sample(null, 10), sample(10, 10, 10), sample(10, 10))).toBe(10);
  });

  it('keeps what is held across a failed run', () => {
    const metrics = new QueueMetrics(() => ({ profiles: [] }));
    const run = { profile: 'p', at: new Date(), ok: true, errorCode: null };
    metrics.runFinished({ run, samples: [sample(null, 10)] });
    metrics.runFinished({ run, samples: [sample(10, 10, 10)] });
    metrics.runFinished({ run: { ...run, ok: false, errorCode: 'x' }, samples: [] });
    metrics.runFinished({ run, samples: [sample(10, 0)] });
    expect(metrics.families().find((f) => f.name.endsWith('_arrived_messages_total'))!.series[0]!.value).toBe(0);
  });
});
