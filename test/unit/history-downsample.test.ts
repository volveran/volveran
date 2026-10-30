// A queue's history is served at no more than about 500 points: each bucket's
// last depth and summed estimated arrivals.
import { describe, expect, it } from 'vitest';
import { downsample } from '../../src/server/history/downsample.js';

const sample = (at: number, depth: number, estimatedArrivals: number | null) => ({ at, depth, estimatedArrivals });

describe('downsample', () => {
  it('returns as few Samples as the limit unchanged', () => {
    const samples = [sample(0, 1, null), sample(60, 2, 1), sample(120, 3, 1)];
    expect(downsample(samples, 3)).toEqual(samples);
  });

  it('keeps each bucket\'s last depth and time, and sums its arrivals', () => {
    const samples = [sample(0, 1, 1), sample(10, 2, 2), sample(20, 3, 3), sample(30, 4, 4)];
    expect(downsample(samples, 2)).toEqual([sample(10, 2, 3), sample(30, 4, 7)]);
  });

  it('keeps unknown arrivals unknown only when the whole bucket is unknown', () => {
    const samples = [sample(0, 1, null), sample(10, 2, null), sample(20, 3, null), sample(30, 4, 4)];
    expect(downsample(samples, 2)).toEqual([sample(10, 2, null), { ...sample(30, 4, 4), arrivalsPartlyUnknown: true }]);
  });

  it('marks a bucket with any unknown Sample as partly unknown, so a short unknown stretch does not vanish', () => {
    const samples = [sample(0, 1, 2), sample(10, 2, null), sample(20, 3, 3), sample(30, 4, 4)];
    expect(downsample(samples, 2)).toEqual([{ ...sample(10, 2, 2), arrivalsPartlyUnknown: true }, sample(30, 4, 7)]);
  });

  it('marks it whichever Sample of the bucket was unknown', () => {
    const samples = [sample(0, 1, null), sample(10, 2, 2), sample(20, 3, 3), sample(30, 4, 4)];
    expect(downsample(samples, 2)[0]).toEqual({ ...sample(10, 2, 2), arrivalsPartlyUnknown: true });
  });

  it('leaves no points where there were no Samples, so a gap stays a gap', () => {
    const samples = [sample(0, 1, 0), sample(10, 1, 0), sample(1000, 9, 8), sample(1010, 9, 0)];
    const points = downsample(samples, 3);
    expect(points.map((p) => p.at)).toEqual([10, 1010]);
  });

  it('never exceeds the limit on a long history', () => {
    const samples = Array.from({ length: 20_160 }, (_, i) => sample(i * 60_000, i, 1));
    const points = downsample(samples, 500);
    expect(points.length).toBeLessThanOrEqual(500);
    expect(points.at(-1)).toMatchObject({ at: 20_159 * 60_000, depth: 20_159 });
    expect(points.reduce((sum, p) => sum + p.estimatedArrivals!, 0)).toBe(20_160);
  });

  it('copes with no Samples, and with Samples all at one time', () => {
    expect(downsample([], 500)).toEqual([]);
    expect(downsample([sample(5, 1, 1), sample(5, 2, 1), sample(5, 3, null)], 2)).toEqual([{ ...sample(5, 3, 2), arrivalsPartlyUnknown: true }]);
  });
});
