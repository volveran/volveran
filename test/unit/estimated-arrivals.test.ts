// Estimated arrivals: the broker does not count dead-lettered Messages in
// message_stats.publish (docs/rabbitmq-behaviour.md), so a Sample's arrivals
// come from the depth change and the Messages Volverán itself took out.
import { describe, expect, it } from 'vitest';
import { estimateArrivals } from '../../src/server/history/estimated-arrivals.js';

describe('estimateArrivals', () => {
  it('is unknown, not zero, on the first Sample of a queue', () => {
    expect(estimateArrivals({ previousDepth: null, depth: 40, takenOut: 0 })).toBeNull();
  });

  it('is the rise in depth when nothing was taken out', () => {
    expect(estimateArrivals({ previousDepth: 10, depth: 25, takenOut: 0 })).toBe(15);
  });

  it('adds the Messages Volverán took out, so triage does not hide arrivals', () => {
    expect(estimateArrivals({ previousDepth: 10, depth: 12, takenOut: 3 })).toBe(5);
    expect(estimateArrivals({ previousDepth: 10, depth: 8, takenOut: 5 })).toBe(3);
  });

  it('counts nothing when triage alone explains the drop', () => {
    expect(estimateArrivals({ previousDepth: 10, depth: 0, takenOut: 10 })).toBe(0);
  });

  it('is never negative when something outside Volverán drained the queue', () => {
    expect(estimateArrivals({ previousDepth: 10, depth: 2, takenOut: 0 })).toBe(0);
    expect(estimateArrivals({ previousDepth: 10, depth: 2, takenOut: 1 })).toBe(0);
  });
});
