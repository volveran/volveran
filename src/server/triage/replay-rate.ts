// Pure (no I/O): which Replay Rate an Apply runs at, and whether it would
// outlast its Checkout at that rate.
//
// The request's `rate` wins; without one the Broker Profile's
// `replayRate.default` applies, else the Apply is unthrottled. A rate above
// `replayRate.max` is refused, and so is no rate at all when the profile sets
// a maximum but no default (unthrottled is faster than any maximum).
import type { ReplayRateLimits } from '../profiles.js';
import { isReplayRate, pacedDurationMs } from '../../shared/replay-rate.js';

export type ResolvedReplayRate =
  | { ok: true; rate: number | null }
  | { ok: false; problem: 'invalid' }
  | { ok: false; problem: 'above_maximum'; max: number };

export function resolveReplayRate(requested: unknown, limits: ReplayRateLimits): ResolvedReplayRate {
  if (requested !== undefined && requested !== null && !isReplayRate(requested)) return { ok: false, problem: 'invalid' };
  const rate = (requested as number | null | undefined) ?? limits.default;
  if (limits.max !== null && (rate === null || rate > limits.max)) return { ok: false, problem: 'above_maximum', max: limits.max };
  return { ok: true, rate };
}

/** How close to its end a paced Apply may be estimated to run: the steps themselves and the return of the rest take time too. */
export const APPLY_TIME_MARGIN_MS = 10_000;

/**
 * Null when `pacedSteps` (Replay and Move) at `rate` fit in the Checkout's
 * time left minus APPLY_TIME_MARGIN_MS (always, unthrottled); else how long
 * they need and how long is left.
 */
export function applyOutlastsCheckout(input: {
  pacedSteps: number;
  rate: number | null;
  remainingMs: number;
}): { neededMs: number; remainingMs: number } | null {
  const neededMs = pacedDurationMs(input.pacedSteps, input.rate);
  if (neededMs === null || neededMs <= input.remainingMs - APPLY_TIME_MARGIN_MS) return null;
  return { neededMs, remainingMs: input.remainingMs };
}
