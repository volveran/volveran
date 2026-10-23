// Pure retention rules for Discarded Message bodies (no I/O): Audit Entries
// are kept forever, but the bodies Discard stores for Restore are kept only
// for VOLVERAN_BODY_RETENTION_DAYS (default 30) and while the stored bodies
// stay within VOLVERAN_BODY_RETENTION_MAX_BYTES (default 1 GiB), whichever
// limit is reached first, oldest evicted first (AuditStore.evictBodies).
// Retention runs at startup and every VOLVERAN_BODY_RETENTION_INTERVAL_MINUTES.

export interface BodyRetention {
  /** Bodies older than this are evicted. */
  maxAgeMs: number;
  /** The stored bodies may add up to this many bytes; the oldest are evicted beyond it. */
  maxBodyBytes: number;
  /** How often retention runs (it also runs at startup). */
  intervalMs: number;
}

const MINUTE = 60 * 1000;
const DAY = 24 * 60 * MINUTE;

export const DEFAULT_BODY_RETENTION: BodyRetention = {
  maxAgeMs: 30 * DAY,
  maxBodyBytes: 1024 ** 3,
  intervalMs: 60 * MINUTE,
};

/** The UI warns once the stored bodies reach this share of the size limit. */
export const NEAR_LIMIT_RATIO = 0.9;

const UNITS: Record<string, number> = { '': 1, B: 1, KIB: 1024, MIB: 1024 ** 2, GIB: 1024 ** 3, TIB: 1024 ** 4 };

/** The retention limits from the environment, each defaulting to DEFAULT_BODY_RETENTION. */
export function parseBodyRetention(
  env: Record<string, string | undefined>,
): { ok: true; retention: BodyRetention } | { ok: false; error: string } {
  const whole = (name: string, fallback: number, max: number): number | string => {
    const raw = env[name]?.trim();
    if (!raw) return fallback;
    const n = Number(raw);
    if (!/^\d+$/.test(raw) || n < 1 || n > max) return `${name} must be a whole number from 1 to ${max}, not "${raw}".`;
    return n;
  };
  const days = whole('VOLVERAN_BODY_RETENTION_DAYS', DEFAULT_BODY_RETENTION.maxAgeMs / DAY, 36500);
  if (typeof days === 'string') return { ok: false, error: days };
  const minutes = whole('VOLVERAN_BODY_RETENTION_INTERVAL_MINUTES', DEFAULT_BODY_RETENTION.intervalMs / MINUTE, 1440);
  if (typeof minutes === 'string') return { ok: false, error: minutes };

  let maxBodyBytes = DEFAULT_BODY_RETENTION.maxBodyBytes;
  const size = env.VOLVERAN_BODY_RETENTION_MAX_BYTES?.trim();
  if (size) {
    const match = /^(\d+)\s*([a-z]*)$/i.exec(size);
    const unit = match && UNITS[match[2]!.toUpperCase()];
    const bytes = match && unit ? Number(match[1]) * unit : NaN;
    if (!Number.isSafeInteger(bytes) || bytes < 1) {
      return {
        ok: false,
        error: `VOLVERAN_BODY_RETENTION_MAX_BYTES must be a whole number of bytes, optionally with KiB, MiB, GiB or TiB (e.g. 1GiB), not "${size}".`,
      };
    }
    maxBodyBytes = bytes;
  }
  return { ok: true, retention: { maxAgeMs: days * DAY, maxBodyBytes, intervalMs: minutes * MINUTE } };
}

/** How full the body store is, for GET /api/audit-store and the UI warning. */
export interface BodyStoreUsage {
  storedBodyBytes: number;
  maxBodyBytes: number;
  maxAgeDays: number;
  /** The stored bodies have reached NEAR_LIMIT_RATIO of the size limit: the oldest will soon be evicted. */
  nearLimit: boolean;
}

export function bodyStoreUsage(storedBodyBytes: number, retention: BodyRetention): BodyStoreUsage {
  return {
    storedBodyBytes,
    maxBodyBytes: retention.maxBodyBytes,
    maxAgeDays: retention.maxAgeMs / DAY,
    nearLimit: storedBodyBytes >= retention.maxBodyBytes * NEAR_LIMIT_RATIO,
  };
}
