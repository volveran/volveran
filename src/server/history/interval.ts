// Pure startup setting: how often the sampler reads the dead-letter queues
// (VOLVERAN_HISTORY_INTERVAL_SECONDS, 15 to 3600, default 60).
const DEFAULT_SECONDS = 60;
const MIN_SECONDS = 15;
const MAX_SECONDS = 3600;

export function parseHistoryInterval(
  env: Record<string, string | undefined>,
): { ok: true; intervalMs: number } | { ok: false; error: string } {
  const value = env.VOLVERAN_HISTORY_INTERVAL_SECONDS?.trim();
  if (!value) return { ok: true, intervalMs: DEFAULT_SECONDS * 1000 };
  const seconds = Number(value);
  if (!Number.isInteger(seconds) || seconds < MIN_SECONDS || seconds > MAX_SECONDS) {
    return { ok: false, error: `VOLVERAN_HISTORY_INTERVAL_SECONDS must be a whole number of seconds from ${MIN_SECONDS} to ${MAX_SECONDS}, not "${value}".` };
  }
  return { ok: true, intervalMs: seconds * 1000 };
}
