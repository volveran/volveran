// The pure logic of the depth charts: scales, where a line breaks, where marks
// and unknown arrivals land, the arrival rate and the text summaries.
import { describe, expect, it } from 'vitest';
import {
  arrivalRates,
  arrivalsSummary,
  chartSegments,
  depthSummary,
  isDot,
  niceMax,
  placeMarks,
  rangeMs,
  timeX,
  unknownArrivalBands,
  valueY,
} from '../../src/web/history-chart.js';

const MINUTE = 60_000;
const at = (minute: number) => minute * MINUTE;
const point = (minute: number, value: number | null = 1) => ({ at: at(minute), value });
const minutes = (segments: Array<Array<{ at: number }>>) => segments.map((s) => s.map((p) => p.at / MINUTE));

describe('scales', () => {
  it('places a time across the range', () => {
    const scale = { from: at(0), to: at(60), width: 600 };
    expect(timeX(at(0), scale)).toBe(0);
    expect(timeX(at(30), scale)).toBe(300);
    expect(timeX(at(60), scale)).toBe(600);
  });

  it('puts zero at the bottom and the maximum at the top', () => {
    expect(valueY(0, 50, 100)).toBe(100);
    expect(valueY(50, 50, 100)).toBe(0);
    expect(valueY(25, 50, 100)).toBe(50);
  });

  it('rounds the top of the scale up to a readable number', () => {
    expect(niceMax([])).toBe(1);
    expect(niceMax([0, 0])).toBe(1);
    expect(niceMax([3])).toBe(5);
    expect(niceMax([7, 2])).toBe(10);
    expect(niceMax([120])).toBe(200);
    expect(niceMax([400])).toBe(500);
    expect(niceMax([1000])).toBe(1000);
    expect(niceMax([0.3])).toBe(0.5);
  });

  it('gives each range its length, the whole retention from the setting', () => {
    expect(rangeMs('1h', 14)).toBe(60 * MINUTE);
    expect(rangeMs('24h', 14)).toBe(24 * 60 * MINUTE);
    expect(rangeMs('7d', 14)).toBe(7 * 24 * 60 * MINUTE);
    expect(rangeMs('retention', 30)).toBe(30 * 24 * 60 * MINUTE);
  });
});

describe('chartSegments', () => {
  it('keeps evenly spaced points in one line', () => {
    expect(minutes(chartSegments([point(0), point(1), point(2)], []))).toEqual([[0, 1, 2]]);
  });

  it('breaks the line across a gap, keeping the points on its edges on either side', () => {
    const points = [point(0), point(1), point(5), point(6)];
    expect(minutes(chartSegments(points, [{ from: at(1), to: at(5) }]))).toEqual([
      [0, 1],
      [5, 6],
    ]);
  });

  it('breaks the line at a point with no value', () => {
    const points = [point(0), point(1), point(2, null), point(3), point(4)];
    expect(minutes(chartSegments(points, []))).toEqual([
      [0, 1],
      [3, 4],
    ]);
  });

  it('keeps a lone point between two gaps, to be drawn as a dot', () => {
    const points = [point(0), point(1), point(4), point(7), point(8)];
    const gaps = [
      { from: at(1), to: at(4) },
      { from: at(4), to: at(7) },
    ];
    expect(minutes(chartSegments(points, gaps))).toEqual([[0, 1], [4], [7, 8]]);
  });

  it('breaks the line where a queue has no Samples though sampling ran', () => {
    // The queue was deleted for a while: no gap, because the profile kept being sampled.
    const points = [point(0), point(1), point(2), point(3), point(30), point(31), point(32)];
    expect(minutes(chartSegments(points, []))).toEqual([
      [0, 1, 2, 3],
      [30, 31, 32],
    ]);
  });

  it('has no line without points', () => {
    expect(chartSegments([], [{ from: at(0), to: at(5) }])).toEqual([]);
  });
});

describe('arrivalRates', () => {
  const sample = (minute: number, estimatedArrivals: number | null) => ({ at: at(minute), estimatedArrivals });

  it('turns the arrivals since the point before into Messages per minute', () => {
    expect(arrivalRates([sample(0, 0), sample(2, 10), sample(3, 3)])).toEqual([
      { at: at(0), value: null },
      { at: at(2), value: 5 },
      { at: at(3), value: 3 },
    ]);
  });

  it('keeps unknown arrivals unknown, never zero', () => {
    expect(arrivalRates([sample(0, null), sample(1, null), sample(2, 4)])).toEqual([
      { at: at(0), value: null },
      { at: at(1), value: null },
      { at: at(2), value: 4 },
    ]);
  });

  it('keeps no arrivals at zero', () => {
    expect(arrivalRates([sample(0, 0), sample(1, 0)])[1]).toEqual({ at: at(1), value: 0 });
  });
});

describe('unknownArrivalBands', () => {
  const sample = (minute: number, estimatedArrivals: number | null) => ({ at: at(minute), estimatedArrivals });

  it('covers the stretch each unknown point stands for, merged', () => {
    expect(unknownArrivalBands([sample(0, 1), sample(1, null), sample(2, null), sample(3, 1), sample(4, null)])).toEqual([
      { from: at(0), to: at(2) },
      { from: at(3), to: at(4) },
    ]);
  });

  it('marks a first point at its own time', () => {
    expect(unknownArrivalBands([sample(5, null), sample(6, 2)])).toEqual([{ from: at(5), to: at(5) }]);
  });

  it('is empty when all are known', () => {
    expect(unknownArrivalBands([sample(0, 0), sample(1, 2)])).toEqual([]);
  });
});

describe('placeMarks', () => {
  const mark = (minute: number) => ({ at: new Date(at(minute)).toISOString() });
  const scale = { from: at(10), to: at(20), width: 100 };

  it('places a mark at its time and leaves out those off the range', () => {
    const placed = placeMarks([mark(5), mark(10), mark(15), mark(20), mark(25)], scale);
    expect(placed.map((p) => p.x)).toEqual([0, 50, 100]);
    expect(placed[1]!.mark).toEqual(mark(15));
  });
});

describe('text summaries', () => {
  const time = (ms: number) => `t${ms / MINUTE}`;

  it('says the current, lowest and highest depth and the latest Sample time', () => {
    expect(depthSummary([4, 9, 2, 7], at(3), time)).toBe('Depth now 7, lowest 2, highest 9. Latest Sample t3.');
  });

  it('says so when there is nothing to summarise, with the latest Sample if there is an older one', () => {
    expect(depthSummary([], null, time)).toBe('No Samples yet.');
    expect(depthSummary([], at(3), time)).toBe('No Samples in this range. Latest Sample t3.');
  });

  it('adds up the estimated arrivals and says how many points are unknown', () => {
    expect(arrivalsSummary([{ estimatedArrivals: 3 }, { estimatedArrivals: 0 }, { estimatedArrivals: 4 }])).toBe(
      'Estimated arrivals: 7 in this range.',
    );
    expect(arrivalsSummary([{ estimatedArrivals: null }, { estimatedArrivals: 4 }])).toBe(
      'Estimated arrivals: 4 in this range, unknown for 1 of 2 Samples shown.',
    );
  });

  it('says unknown, never zero, when no arrivals are known', () => {
    expect(arrivalsSummary([{ estimatedArrivals: null }, { estimatedArrivals: null }])).toBe('Estimated arrivals: unknown.');
    expect(arrivalsSummary([])).toBe('Estimated arrivals: unknown.');
  });
});

describe('a downsampled point that is partly unknown', () => {
  const samples = [
    { at: at(0), estimatedArrivals: 1 },
    { at: at(10), estimatedArrivals: 2, arrivalsPartlyUnknown: true },
    { at: at(20), estimatedArrivals: 3 },
  ];

  it('is hatched as unknown, though its point keeps what is known', () => {
    expect(unknownArrivalBands(samples)).toEqual([{ from: at(0), to: at(10) }]);
    expect(arrivalRates(samples).map((p) => p.value)).toEqual([null, 0.2, 0.3]);
  });

  it('is said in the summary, not added up as complete', () => {
    expect(arrivalsSummary(samples)).toBe('Estimated arrivals: 6 in this range, partly unknown for 1 of 3 Samples shown.');
    const unknown = { at: at(30), estimatedArrivals: null };
    expect(arrivalsSummary([...samples, unknown])).toBe('Estimated arrivals: 6 in this range, unknown for 1 of 4 Samples shown, partly unknown for 1 more.');
  });
});

describe('a line too short to see', () => {
  const scale = { from: at(0), to: at(24 * 60), width: 96 };

  it('is a dot: a few Samples in a whole day span less than a pixel', () => {
    expect(isDot([point(0), point(1), point(2)], scale)).toBe(true);
  });

  it('is a line once it spans enough to be seen, and a lone point is always a dot', () => {
    expect(isDot([point(0), point(60)], scale)).toBe(false);
    expect(isDot([point(5)], scale)).toBe(true);
  });
});
