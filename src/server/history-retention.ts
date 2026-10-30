// Pure startup setting: how many days of history the audit store keeps
// (VOLVERAN_HISTORY_RETENTION_DAYS, 1 to 90, default 14).
const DAY_MS = 24 * 3_600_000;
const DEFAULT_DAYS = 14;
const MIN_DAYS = 1;
const MAX_DAYS = 90;

export function parseHistoryRetention(
  env: Record<string, string | undefined>,
): { ok: true; retentionMs: number } | { ok: false; error: string } {
  const value = env.VOLVERAN_HISTORY_RETENTION_DAYS?.trim();
  if (!value) return { ok: true, retentionMs: DEFAULT_DAYS * DAY_MS };
  const days = Number(value);
  if (!Number.isInteger(days) || days < MIN_DAYS || days > MAX_DAYS) {
    return { ok: false, error: `VOLVERAN_HISTORY_RETENTION_DAYS must be a whole number of days from ${MIN_DAYS} to ${MAX_DAYS}, not "${value}".` };
  }
  return { ok: true, retentionMs: days * DAY_MS };
}
