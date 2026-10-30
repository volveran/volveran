// Pure startup configuration (no I/O): every setting Volverán reads from the
// environment, checked together so startup fails on the first problem with
// a message naming the variable. The profiles file is read separately
// (profiles.ts).
import { parseBodyRetention, type BodyRetention } from './audit/body-retention.js';
import { parseMetricsPort } from './metrics/config.js';
import { resolveRunMode, type RunMode } from './run-mode.js';
import { parseCheckoutLimits, type CheckoutLimits } from './triage/checkout-collection.js';
import { parseCheckoutTiming, type CheckoutTiming } from './triage/checkout-timing.js';

export interface Config {
  mode: RunMode;
  checkoutLimits: CheckoutLimits;
  checkoutTiming: CheckoutTiming;
  bodyRetention: BodyRetention;
  /** The metrics listener's port; null keeps it off. */
  metricsPort: number | null;
}

/** Reads the configuration from `env`; `host` is the listen address (Solo Mode accepts loopback only). */
export function loadConfig(
  env: Record<string, string | undefined>,
  host: string,
): { ok: true; config: Config } | { ok: false; error: string } {
  const mode = resolveRunMode(env, host);
  if (!mode.ok) return mode;
  const limits = parseCheckoutLimits(env);
  if (!limits.ok) return limits;
  const timing = parseCheckoutTiming(env);
  if (!timing.ok) return timing;
  const retention = parseBodyRetention(env);
  if (!retention.ok) return retention;
  const metricsPort = parseMetricsPort(env);
  if (!metricsPort.ok) return metricsPort;
  return {
    ok: true,
    config: {
      mode: mode.mode,
      checkoutLimits: limits.limits,
      checkoutTiming: timing.timing,
      bodyRetention: retention.retention,
      metricsPort: metricsPort.port,
    },
  };
}
