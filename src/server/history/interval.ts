// Pure startup setting: how often the sampler reads the dead-letter queues
// (VOLVERAN_HISTORY_INTERVAL_SECONDS, 15 to 3600, default 60).
import { parseWholeNumberSetting } from './whole-number-setting.js';

export function parseHistoryInterval(
  env: Record<string, string | undefined>,
): { ok: true; intervalMs: number } | { ok: false; error: string } {
  const seconds = parseWholeNumberSetting(env, { name: 'VOLVERAN_HISTORY_INTERVAL_SECONDS', unit: 'seconds', defaultValue: 60, min: 15, max: 3600 });
  return seconds.ok ? { ok: true, intervalMs: seconds.value * 1000 } : seconds;
}
