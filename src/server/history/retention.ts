// Pure startup setting: how many days of history the audit store keeps
// (VOLVERAN_HISTORY_RETENTION_DAYS, 1 to 90, default 14).
import { parseWholeNumberSetting } from './whole-number-setting.js';

const DAY_MS = 24 * 3_600_000;

export function parseHistoryRetention(
  env: Record<string, string | undefined>,
): { ok: true; retentionMs: number } | { ok: false; error: string } {
  const days = parseWholeNumberSetting(env, { name: 'VOLVERAN_HISTORY_RETENTION_DAYS', unit: 'days', defaultValue: 14, min: 1, max: 90 });
  return days.ok ? { ok: true, retentionMs: days.value * DAY_MS } : days;
}
