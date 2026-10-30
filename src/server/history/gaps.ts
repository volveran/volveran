// Pure: the gaps of a Broker Profile's history in a range, from its sampling
// runs: the stretches around failed runs (from the last good run to the next
// one) and where runs are missing because Volverán was not running. The time
// before sampling first ran is not a gap, there was never anything to show.
export interface GapRun {
  at: number;
  ok: boolean;
  errorCode: string | null;
}

export interface Gap {
  from: number;
  to: number;
  /** The last failed run's error; null when runs were simply missing. */
  errorCode: string | null;
}

/** Runs further apart than this many intervals mean some are missing (timers drift, so not 1). */
const MISSING_AFTER_INTERVALS = 1.5;

/**
 * `runs` in time order: those in the range, plus enough around it to see a
 * gap crossing its edges (back to the last good run before it, on to the first
 * good run after it).
 */
export function historyGaps(runs: readonly GapRun[], range: { from: number; to: number; now: number; intervalMs: number }): Gap[] {
  const end = Math.min(range.to, range.now);
  const missing = range.intervalMs * MISSING_AFTER_INTERVALS;
  const gaps: Gap[] = [];
  const add = (from: number, to: number, errorCode: string | null) => {
    const clipped = { from: Math.max(from, range.from), to: Math.min(to, end), errorCode };
    if (clipped.from < clipped.to) gaps.push(clipped);
  };

  let lastOk: number | null = null;
  let failing = null as { since: number; errorCode: string | null } | null;
  for (const run of runs) {
    if (!run.ok) {
      failing = { since: failing?.since ?? run.at, errorCode: run.errorCode };
      continue;
    }
    if (failing) add(lastOk ?? failing.since, run.at, failing.errorCode);
    else if (lastOk !== null && run.at - lastOk > missing) add(lastOk, run.at, null);
    lastOk = run.at;
    failing = null;
  }
  if (failing) add(lastOk ?? failing.since, end, failing.errorCode);
  else if (lastOk !== null && end - lastOk > missing) add(lastOk, end, null);
  return gaps;
}
