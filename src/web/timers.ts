// Timer hooks the Checkout and Approvals pages share: a clock for their
// countdowns, and reading something from the server again and again.
import { useEffect, useState, type DependencyList } from 'react';
import type { ApiError } from './api.js';

/** Date.now(), every second while `ticking`. */
export function useNow(ticking = true): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!ticking) return;
    const timer = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(timer);
  }, [ticking]);
  return now;
}

export interface Polling<T> {
  load(): Promise<T>;
  received(value: T): void;
  failed(err: ApiError): void;
  /**
   * How often to load again. A function is given the first result and
   * polling starts only once that arrives; a number starts it at once.
   */
  everyMs: number | ((first: T) => number);
  /** Off: nothing is loaded. */
  enabled?: boolean;
}

/** How soon a first load that failed and may be tried again is, when polling waits for its result to know how often. */
const FIRST_LOAD_RETRY_MS = 2_000;

/**
 * Loads now, then again every `everyMs`, until stopped; what arrives after that is dropped.
 * A first load that says to try again (`tryAgain`) is tried again: polling that waits for
 * it would otherwise never start, and a Checkout would go without its heartbeat.
 */
export function startPolling<T>({ load, received, failed, everyMs }: Omit<Polling<T>, 'enabled'>): () => void {
    let cancelled = false;
    let timer: ReturnType<typeof setInterval> | undefined;
    let retry: ReturnType<typeof setTimeout> | undefined;
    const once = () =>
      load().then(
        (value) => {
          if (!cancelled) received(value);
          return value;
        },
        (err: ApiError) => {
          if (!cancelled) failed(err);
          throw err;
        },
      );
    if (typeof everyMs === 'number') {
      once().catch(() => {});
      timer = setInterval(() => once().catch(() => {}), everyMs);
    } else {
      const first = (): Promise<void> =>
        once().then(
          (value) => {
            if (!cancelled) timer = setInterval(() => once().catch(() => {}), everyMs(value));
          },
          (err: ApiError) => {
            if (!cancelled && err.details?.tryAgain === true) retry = setTimeout(() => void first(), FIRST_LOAD_RETRY_MS);
          },
        );
      void first();
    }
    return () => {
      cancelled = true;
      clearInterval(timer);
      clearTimeout(retry);
    };
}

/** startPolling, until `deps` change or the component goes away. */
export function usePolling<T>({ enabled = true, ...polling }: Polling<T>, deps: DependencyList): void {
  useEffect(() => {
    if (!enabled) return;
    return startPolling(polling);
  }, [enabled, ...deps]);
}
