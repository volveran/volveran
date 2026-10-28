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

/**
 * Loads now, then again every `everyMs`, until `deps` change or the
 * component goes away; what arrives after that is dropped.
 */
export function usePolling<T>({ load, received, failed, everyMs, enabled = true }: Polling<T>, deps: DependencyList): void {
  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    let timer: ReturnType<typeof setInterval> | undefined;
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
      once()
        .then((first) => {
          if (!cancelled) timer = setInterval(() => once().catch(() => {}), everyMs(first));
        })
        .catch(() => {});
    }
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [enabled, ...deps]);
}
