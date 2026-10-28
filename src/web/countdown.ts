// Durations as the Checkout pages show them: m:ss, e.g. "29:58".

/** `ms` as m:ss, rounded up to the second; 0:00 once it is past. */
export function formatCountdown(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}
