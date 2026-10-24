// Pure Checkout timing rules (no I/O, ADR 0006): how long a Checkout may hold
// Messages. A Checkout ends itself at its time limit, and when the browser
// has sent no heartbeat for the heartbeat window. On quorum queues its
// consumer also carries `x-consumer-timeout` a margin past the time limit, a
// backstop for when Volverán itself fails to end it: the broker then takes
// the Messages back and the Checkout is lost.

export interface CheckoutTiming {
  /** How long a Checkout may hold Messages (default 30 minutes). */
  timeLimitMs: number;
  /** A Checkout without a browser heartbeat for this long ends (default 2 minutes). */
  heartbeatWindowMs: number;
  /** How far past the time limit the broker's quorum consumer timeout is set (default 1 minute). */
  consumerTimeoutMarginMs: number;
}

const SECOND = 1000;
const MINUTE = 60 * SECOND;

export const DEFAULT_CHECKOUT_TIMING: CheckoutTiming = {
  timeLimitMs: 30 * MINUTE,
  heartbeatWindowMs: 2 * MINUTE,
  consumerTimeoutMarginMs: MINUTE,
};

/**
 * The Checkout timing from `VOLVERAN_CHECKOUT_TIME_LIMIT_MINUTES` (1 to 1440)
 * and `VOLVERAN_CHECKOUT_HEARTBEAT_SECONDS` (10 to 3600), each defaulting to
 * DEFAULT_CHECKOUT_TIMING.
 */
export function parseCheckoutTiming(
  env: Record<string, string | undefined>,
): { ok: true; timing: CheckoutTiming } | { ok: false; error: string } {
  const read = (name: string, fallback: number, min: number, max: number): number | string => {
    const raw = env[name]?.trim();
    if (!raw) return fallback;
    const n = Number(raw);
    if (!/^\d+$/.test(raw) || n < min || n > max) return `${name} must be a whole number from ${min} to ${max}, not "${raw}".`;
    return n;
  };
  const minutes = read('VOLVERAN_CHECKOUT_TIME_LIMIT_MINUTES', DEFAULT_CHECKOUT_TIMING.timeLimitMs / MINUTE, 1, 1440);
  if (typeof minutes === 'string') return { ok: false, error: minutes };
  const seconds = read('VOLVERAN_CHECKOUT_HEARTBEAT_SECONDS', DEFAULT_CHECKOUT_TIMING.heartbeatWindowMs / SECOND, 10, 3600);
  if (typeof seconds === 'string') return { ok: false, error: seconds };
  return {
    ok: true,
    timing: { ...DEFAULT_CHECKOUT_TIMING, timeLimitMs: minutes * MINUTE, heartbeatWindowMs: seconds * SECOND },
  };
}

/** The `x-consumer-timeout` of a quorum Checkout consumer: the time limit plus the margin. */
export function consumerTimeoutMs(timing: CheckoutTiming): number {
  return timing.timeLimitMs + timing.consumerTimeoutMarginMs;
}

/** Milliseconds left until `endsAt` at `now`, never below 0. */
export function remainingMs(endsAt: Date, now: Date): number {
  return Math.max(0, endsAt.getTime() - now.getTime());
}
