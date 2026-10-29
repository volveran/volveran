// Pacing at a Replay Rate: the steps that publish (Replay, Move) start at
// least 1/rate apart, so a recovering consumer gets a steady trickle instead
// of a burst. The executor waits here between steps, after the previous
// step's ack and before asking whether to go on, never inside a step (ADR
// 0001's order is unchanged). A stop wakes the wait at once. Replay rules
// pace their passes with the same pacer at their own rate.

export { pacedDurationMs } from '../../shared/replay-rate.js';

export interface Pacer {
  /**
   * Resolves when the next paced step may start: at once for the first one
   * and when unthrottled, else 1/rate after the previous one started. Resolves
   * early (and from then on at once) when `signal` aborts. Never rejects.
   */
  wait(signal?: AbortSignal): Promise<void>;
}

/** A pacer for `rate` Messages per second; null paces nothing. */
export function pacer(rate: number | null): Pacer {
  const intervalMs = rate === null ? 0 : 1000 / rate;
  let lastStart: number | null = null;
  return {
    async wait(signal) {
      const delay = lastStart === null ? 0 : lastStart + intervalMs - Date.now();
      if (delay > 0 && !signal?.aborted) await sleep(delay, signal);
      lastStart = Date.now();
    },
  };
}

function sleep(ms: number, signal: AbortSignal | undefined): Promise<void> {
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal?.addEventListener('abort', done, { once: true });
  });
}
