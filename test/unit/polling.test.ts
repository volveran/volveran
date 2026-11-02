// What a page's polling does when an answer is "try again": a Checkout's heartbeat through a
// Replica that cannot reach the owner must keep going, or the Checkout ends under the Operator.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../../src/web/api.js';
import { startPolling } from '../../src/web/timers.js';

const unreachable = () => new ApiError(503, 'replica_unreachable', 'Try again in a moment.', { tryAgain: true });

describe('polling that learns how often from its first result', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  /** Runs polling on answers given in turn; the last repeats. */
  function poll(answers: Array<number | ApiError>) {
    let call = 0;
    const received: number[] = [];
    const failed: string[] = [];
    const load = vi.fn(async () => {
      const answer = answers[Math.min(call++, answers.length - 1)]!;
      if (answer instanceof ApiError) throw answer;
      return answer;
    });
    const stop = startPolling({ load, received: (v) => received.push(v), failed: (e) => failed.push(e.code), everyMs: () => 1_000 });
    return { load, received, failed, stop };
  }

  it('keeps trying after a first answer that says to try again, then polls as usual', async () => {
    const { load, received, failed, stop } = poll([unreachable(), unreachable(), 7]);
    await vi.advanceTimersByTimeAsync(0);
    expect(failed).toEqual(['replica_unreachable']);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(failed).toEqual(['replica_unreachable', 'replica_unreachable']);
    expect(received.length).toBeGreaterThan(1);
    const calls = load.mock.calls.length;
    await vi.advanceTimersByTimeAsync(1_000);
    expect(load.mock.calls.length).toBe(calls + 1);
    stop();
  });

  it('keeps polling through such an answer later on', async () => {
    const { received, failed, stop } = poll([1, unreachable(), 2]);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(failed).toEqual(['replica_unreachable']);
    expect(received).toContain(2);
    stop();
  });

  it('stops after a first answer that does not say to try again', async () => {
    const { load, stop } = poll([new ApiError(404, 'checkout_not_found', 'No such Checkout.')]);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(load).toHaveBeenCalledTimes(1);
    stop();
  });

  it('does nothing more once stopped, even waiting to try again', async () => {
    const { load, stop } = poll([unreachable()]);
    await vi.advanceTimersByTimeAsync(0);
    stop();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(load).toHaveBeenCalledTimes(1);
  });
});
