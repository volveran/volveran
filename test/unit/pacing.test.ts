// Pacing publishing steps at a Replay Rate: consecutive steps start at least
// 1/rate apart, a stop wakes a wait early, and how long paced steps take.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { pacedDurationMs, pacer } from '../../src/server/apply/pacing.js';

/** Whether `promise` has settled once pending timers up to `ms` from now have run. */
async function settledAfter(promise: Promise<void>, ms: number): Promise<boolean> {
  let settled = false;
  void promise.then(() => (settled = true));
  await vi.advanceTimersByTimeAsync(ms);
  return settled;
}

describe('pacer', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('lets every step start at once with no Replay Rate', async () => {
    const pace = pacer(null);
    for (let i = 0; i < 3; i++) expect(await settledAfter(pace.wait(), 0)).toBe(true);
  });

  it('lets the first step start at once, and each next one 1/rate after the one before', async () => {
    const pace = pacer(10);
    expect(await settledAfter(pace.wait(), 0)).toBe(true);
    const second = pace.wait();
    expect(await settledAfter(second, 99)).toBe(false);
    expect(await settledAfter(second, 1)).toBe(true);
    const third = pace.wait();
    expect(await settledAfter(third, 99)).toBe(false);
    expect(await settledAfter(third, 1)).toBe(true);
  });

  it('counts the time a step took towards the wait for the next', async () => {
    const pace = pacer(2);
    await pace.wait();
    await vi.advanceTimersByTimeAsync(400); // the step itself
    expect(await settledAfter(pace.wait(), 100)).toBe(true);
  });

  it('wakes a wait as soon as the Apply is told to stop', async () => {
    const pace = pacer(0.1);
    await pace.wait();
    const stop = new AbortController();
    const waiting = pace.wait(stop.signal);
    expect(await settledAfter(waiting, 1_000)).toBe(false);
    stop.abort();
    expect(await settledAfter(waiting, 0)).toBe(true);
    expect(await settledAfter(pace.wait(stop.signal), 0)).toBe(true);
  });
});

describe('pacedDurationMs', () => {
  it('is unknown without a rate', () => {
    expect(pacedDurationMs(20, null)).toBeNull();
  });

  it('is one interval per paced step at the rate', () => {
    expect(pacedDurationMs(20, 10)).toBe(2_000);
    expect(pacedDurationMs(3, 0.5)).toBe(6_000);
    expect(pacedDurationMs(0, 10)).toBe(0);
  });
});
