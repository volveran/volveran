// The pure logic of the depth charts (HistoryView.tsx): scales, where a line
// breaks so a gap is never drawn as a flat line, where marks and unknown
// arrivals land, the arrival rate, and the text summaries for screen readers.

const MINUTE_MS = 60_000;
const DAY_MS = 24 * 60 * MINUTE_MS;

export type HistoryRange = '1h' | '24h' | '7d' | 'retention';

export function rangeMs(range: HistoryRange, retentionDays: number): number {
  switch (range) {
    case '1h':
      return 60 * MINUTE_MS;
    case '24h':
      return DAY_MS;
    case '7d':
      return 7 * DAY_MS;
    case 'retention':
      return retentionDays * DAY_MS;
  }
}

export interface TimeScale {
  from: number;
  to: number;
  width: number;
}

export function timeX(at: number, { from, to, width }: TimeScale): number {
  return to === from ? 0 : ((at - from) / (to - from)) * width;
}

/** Zero at the bottom (`height`), `max` at the top (0). */
export function valueY(value: number, max: number, height: number): number {
  return height - (value / max) * height;
}

/** The top of a chart's scale: the largest value rounded up to 1, 2 or 5 times a power of ten. */
export function niceMax(values: readonly number[]): number {
  const largest = Math.max(0, ...values);
  if (largest === 0) return 1;
  const power = 10 ** Math.floor(Math.log10(largest));
  const step = [1, 2, 5, 10].find((m) => largest <= m * power)!;
  return step * power;
}

export interface ChartPoint {
  at: number;
  value: number | null;
}

/** How many times the usual spacing two points may lie apart before the queue counts as not sampled between them. */
const HOLE_AFTER_STEPS = 3;

function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)]!;
}

/**
 * The stretches to draw as one line each (one point: a dot). A line breaks at
 * a gap in sampling, at a point with no value, and where the queue has no
 * Samples though its profile was sampled (deleted for a while, or not a
 * dead-letter queue then).
 */
export function chartSegments<P extends ChartPoint>(points: readonly P[], gaps: ReadonlyArray<{ from: number; to: number }>): P[][] {
  const steps = points.slice(1).map((p, i) => p.at - points[i]!.at);
  const longest = steps.length > 0 ? median(steps) * HOLE_AFTER_STEPS : Infinity;
  const segments: P[][] = [];
  let current: P[] = [];
  let previous: P | null = null;
  for (const point of points) {
    const broken =
      previous !== null &&
      (point.at - previous.at > longest || gaps.some((g) => g.from < point.at && g.to > previous!.at));
    if (broken || point.value === null) {
      if (current.length > 0) segments.push(current);
      current = [];
    }
    if (point.value !== null) current.push(point);
    previous = point;
  }
  if (current.length > 0) segments.push(current);
  return segments;
}

/** The shortest line worth drawing as one, in the chart's units. */
const SHORTEST_LINE = 2;

/**
 * Whether to draw a stretch as a dot: a lone point, or one so short across its
 * range that a line would not show (a few Samples in a whole day are well under
 * a pixel of the queue list's small chart).
 */
export function isDot(segment: ReadonlyArray<{ at: number }>, scale: TimeScale): boolean {
  return timeX(segment.at(-1)!.at, scale) - timeX(segment[0]!.at, scale) < SHORTEST_LINE;
}

/** Messages per minute at each point; null when its arrivals are unknown, or there is no point before to measure from. */
export function arrivalRates(samples: ReadonlyArray<{ at: number; estimatedArrivals: number | null }>): ChartPoint[] {
  return samples.map((s, i) => {
    const previous = samples[i - 1];
    if (!previous || s.estimatedArrivals === null) return { at: s.at, value: null };
    return { at: s.at, value: s.estimatedArrivals / ((s.at - previous.at) / MINUTE_MS) };
  });
}

/** The stretches whose arrivals are unknown, wholly or in part; a first point has no stretch, only its time. */
export function unknownArrivalBands(samples: ReadonlyArray<{ at: number; estimatedArrivals: number | null; arrivalsPartlyUnknown?: boolean }>): Array<{ from: number; to: number }> {
  const bands: Array<{ from: number; to: number }> = [];
  samples.forEach((s, i) => {
    if (s.estimatedArrivals !== null && !s.arrivalsPartlyUnknown) return;
    const from = samples[i - 1]?.at ?? s.at;
    const last = bands.at(-1);
    if (last && last.to === from) last.to = s.at;
    else bands.push({ from, to: s.at });
  });
  return bands;
}

export function placeMarks<M extends { at: string }>(marks: readonly M[], scale: TimeScale): Array<{ mark: M; x: number }> {
  return marks
    .map((mark) => ({ mark, at: new Date(mark.at).getTime() }))
    .filter(({ at }) => at >= scale.from && at <= scale.to)
    .map(({ mark, at }) => ({ mark, x: timeX(at, scale) }));
}

/** The text a screen reader gets for a depth chart. */
export function depthSummary(depths: readonly number[], latestSampleAt: number | null, formatTime: (at: number) => string): string {
  if (latestSampleAt === null) return 'No Samples yet.';
  const latest = `Latest Sample ${formatTime(latestSampleAt)}.`;
  if (depths.length === 0) return `No Samples in this range. ${latest}`;
  return `Depth now ${depths.at(-1)}, lowest ${Math.min(...depths)}, highest ${Math.max(...depths)}. ${latest}`;
}

/** The text a screen reader gets for an arrival chart. Unknown is never added up as zero. */
export function arrivalsSummary(samples: ReadonlyArray<{ estimatedArrivals: number | null; arrivalsPartlyUnknown?: boolean }>): string {
  const known = samples.flatMap((s) => (s.estimatedArrivals === null ? [] : [s.estimatedArrivals]));
  if (known.length === 0) return 'Estimated arrivals: unknown.';
  const total = known.reduce((sum, n) => sum + n, 0);
  const unknown = samples.length - known.length;
  const partly = samples.filter((s) => s.arrivalsPartlyUnknown).length;
  const notes = [
    unknown > 0 && `unknown for ${unknown} of ${samples.length} Samples shown`,
    partly > 0 && (unknown > 0 ? `partly unknown for ${partly} more` : `partly unknown for ${partly} of ${samples.length} Samples shown`),
  ].filter(Boolean);
  return `Estimated arrivals: ${total} in this range${notes.map((note) => `, ${note}`).join('')}.`;
}
