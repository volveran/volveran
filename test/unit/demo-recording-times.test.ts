// The demo moves the times of its recording to the moment it loads, so the
// read-only views look as fresh as they did when the screenshots were taken.
import { describe, expect, it } from 'vitest';
import { rebased } from '../../site/demo/api/recording.js';

const hour = 3_600_000;

describe('moving a recording to now', () => {
  it('moves every ISO time and epoch-millisecond time by how long ago it was recorded, and nothing else', () => {
    const recordedAt = '2026-11-04T21:00:00.000Z';
    const now = Date.parse(recordedAt) + 48 * hour;
    const moved = rebased(
      {
        recordedAt,
        depthSeries: { from: Date.parse('2026-11-03T21:00:00.000Z'), to: Date.parse(recordedAt), points: [[Date.parse('2026-11-04T20:00:00.000Z'), 14]] },
        samples: [{ at: '2026-11-04T20:59:45.000Z', depth: 14, estimatedArrivals: null }],
        since: '2026-11-04T20:30:00.123Z',
        id: 7,
        maxBodyBytes: 1_073_741_824,
        body: '{"placedAt":"2026-10-29T06:10:41.118Z"}',
        name: 'orders.dlq',
      },
      now,
    );
    expect(moved).toEqual({
      recordedAt: '2026-11-06T21:00:00.000Z',
      depthSeries: { from: Date.parse('2026-11-05T21:00:00.000Z'), to: now, points: [[Date.parse('2026-11-06T20:00:00.000Z'), 14]] },
      samples: [{ at: '2026-11-06T20:59:45.000Z', depth: 14, estimatedArrivals: null }],
      since: '2026-11-06T20:30:00.123Z',
      id: 7,
      maxBodyBytes: 1_073_741_824,
      body: '{"placedAt":"2026-10-29T06:10:41.118Z"}',
      name: 'orders.dlq',
    });
  });
});
