// Pure startup configuration (no I/O): every setting Volverán reads from the
// environment, checked together so startup fails on the first problem with
// a message naming the variable. The profiles file is read separately
// (profiles.ts).
import { parseBodyRetention, type BodyRetention } from './audit/body-retention.js';
import { parseHistoryInterval } from './history/interval.js';
import { parseHistoryRetention } from './history/retention.js';
import { parsePostgresUrl } from './audit/postgres-url.js';
import { resolvePublicUrl } from './public-url.js';
import { parseMetricsPort } from './metrics/config.js';
import { resolveRunMode, type RunMode } from './run-mode.js';
import { parseCheckoutLimits, type CheckoutLimits } from './triage/checkout-collection.js';
import { parseCheckoutTiming, type CheckoutTiming } from './triage/checkout-timing.js';

export interface Config {
  mode: RunMode;
  checkoutLimits: CheckoutLimits;
  checkoutTiming: CheckoutTiming;
  bodyRetention: BodyRetention;
  /** How often the sampler runs. */
  historyIntervalMs: number;
  /** The base of the links in notifications; null: they carry none. */
  publicUrl: string | null;
  /** How long Samples, sampling runs and notification outcomes are kept, in milliseconds (VOLVERAN_HISTORY_RETENTION_DAYS). */
  historyRetentionMs: number;
  /** The metrics listener's port; null keeps it off. */
  metricsPort: number | null;
  /** The audit store on PostgreSQL (VOLVERAN_POSTGRES_URL); null keeps it on SQLite. */
  postgresUrl: string | null;
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
  const historyInterval = parseHistoryInterval(env);
  if (!historyInterval.ok) return historyInterval;
  const publicUrl = resolvePublicUrl(env, mode.mode);
  if (!publicUrl.ok) return publicUrl;
  const historyRetention = parseHistoryRetention(env);
  if (!historyRetention.ok) return historyRetention;
  const metricsPort = parseMetricsPort(env);
  if (!metricsPort.ok) return metricsPort;
  const postgres = parsePostgresUrl(env);
  if (!postgres.ok) return postgres;
  return {
    ok: true,
    config: {
      mode: mode.mode,
      checkoutLimits: limits.limits,
      checkoutTiming: timing.timing,
      bodyRetention: retention.retention,
      historyIntervalMs: historyInterval.intervalMs,
      publicUrl: publicUrl.url,
      historyRetentionMs: historyRetention.retentionMs,
      metricsPort: metricsPort.port,
      postgresUrl: postgres.url,
    },
  };
}
