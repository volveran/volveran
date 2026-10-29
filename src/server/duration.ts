// Pure (no I/O): durations as the profiles file writes them, a whole number
// and a unit, or several from the largest unit down: `30s`, `5m`, `2h`,
// `1h30m`, `7d`. Units: d, h, m, s. A bare number is refused, so a value in
// seconds is never read as milliseconds or the other way round.

const UNIT_MS: Record<string, number> = { d: 86_400_000, h: 3_600_000, m: 60_000, s: 1000 };
const ORDER = ['d', 'h', 'm', 's'];

/** The duration in milliseconds, or null when `value` is not one. */
export function parseDuration(value: unknown): number | null {
  if (typeof value !== 'string') return null;
  const parts = [...value.trim().matchAll(/(\d+)([dhms])/g)];
  if (parts.length === 0 || parts.map((p) => p[0]).join('') !== value.trim()) return null;
  let last = -1;
  let ms = 0;
  for (const [, amount, unit] of parts) {
    const rank = ORDER.indexOf(unit!);
    if (rank <= last) return null;
    last = rank;
    ms += Number(amount) * UNIT_MS[unit!]!;
  }
  return ms;
}

/** A duration within bounds, in milliseconds; null when `value` is not a duration or out of bounds. */
export function durationWithin(value: unknown, minMs: number, maxMs: number): number | null {
  const ms = parseDuration(value);
  return ms !== null && ms >= minMs && ms <= maxMs ? ms : null;
}
