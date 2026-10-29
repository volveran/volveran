// The progress of an Apply, as the Checkout view shows it.
import { describe, expect, it } from 'vitest';
import { ApplyProgressTracker } from '../../src/server/apply/progress.js';

const at = (s: number) => new Date(Date.UTC(2026, 9, 29, 12, 0, s));

describe('Apply progress', () => {
  it('counts each step by outcome and has no estimate before a step has run', () => {
    const progress = new ApplyProgressTracker(4, at(0));

    expect(progress.view(at(1))).toEqual({
      total: 4,
      done: 0,
      failed: 0,
      notAttempted: 0,
      remaining: 4,
      rate: null,
      startedAt: at(0).toISOString(),
      estimatedEndAt: null,
      stoppedBy: null,
      phase: 'running',
    });

    progress.record('done', at(2));
    progress.record('failed', at(4));
    expect(progress.view(at(4))).toMatchObject({ done: 1, failed: 1, notAttempted: 0, remaining: 2 });
  });

  it('estimates the end from the pace of the steps attempted so far', () => {
    const progress = new ApplyProgressTracker(5, at(0));
    progress.record('done', at(1));
    progress.record('done', at(2));

    // Two steps in 2 s: the three left take about 3 s more.
    expect(progress.view(at(2)).estimatedEndAt).toBe(at(5).toISOString());
  });

  it('ends the estimate when the last step settles, not-attempted ones included', () => {
    const progress = new ApplyProgressTracker(3, at(0));
    progress.record('done', at(1));
    progress.record('not-attempted', at(2));
    progress.record('not-attempted', at(2));

    expect(progress.view(at(9))).toMatchObject({ remaining: 0, notAttempted: 2, estimatedEndAt: at(2).toISOString() });
  });
});
