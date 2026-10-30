// The gaps of a history: where Volverán could not sample the broker, or was
// not sampling at all, so a flat line is never mistaken for a quiet queue.
import { describe, expect, it } from 'vitest';
import { historyGaps } from '../../src/server/history/gaps.js';

const MIN = 60_000;
const ok = (minute: number, intervalMs: number | null = MIN) => ({ at: minute * MIN, ok: true, errorCode: null, intervalMs });
const failed = (minute: number, errorCode = 'broker_unreachable') => ({ at: minute * MIN, ok: false, errorCode, intervalMs: MIN });
const gaps = (runs: Parameters<typeof historyGaps>[0], from = 0, to = 10, now = to) =>
  historyGaps(runs, { from: from * MIN, to: to * MIN, now: now * MIN, intervalMs: MIN });
const gap = (from: number, to: number, errorCode: string | null) => ({ from: from * MIN, to: to * MIN, errorCode });

describe('historyGaps', () => {
  it('finds none while every run succeeds on time', () => {
    expect(gaps([ok(0), ok(1), ok(2)], 0, 2)).toEqual([]);
  });

  it('spans the failed runs, from the last good run to the next, naming the error', () => {
    expect(gaps([ok(0), failed(1), failed(2), ok(3), ok(4)], 0, 4)).toEqual([gap(0, 3, 'broker_unreachable')]);
  });

  it('shows a single failed run, even when runs came close together', () => {
    const runs = [{ at: 0, ok: true, errorCode: null, intervalMs: MIN }, { at: 1, ok: false, errorCode: 'x', intervalMs: MIN }, { at: 2, ok: true, errorCode: null, intervalMs: MIN }];
    expect(historyGaps(runs, { from: 0, to: 2, now: 2, intervalMs: MIN })).toEqual([{ from: 0, to: 2, errorCode: 'x' }]);
  });

  it('finds missing runs, when Volverán was not running, with no error', () => {
    expect(gaps([ok(0), ok(1), ok(6), ok(7)], 0, 7)).toEqual([gap(1, 6, null)]);
  });

  it('runs on to the end of the range while the failure lasts', () => {
    expect(gaps([ok(0), failed(1), failed(2)], 0, 2)).toEqual([gap(0, 2, 'broker_unreachable')]);
  });

  it('starts at the first failed run when no good run came before it', () => {
    expect(gaps([failed(3), failed(4)], 0, 4)).toEqual([gap(3, 4, 'broker_unreachable')]);
  });

  it('finds a trailing gap once runs stop, but not before the next run is due', () => {
    expect(gaps([ok(0), ok(1)], 0, 5)).toEqual([gap(1, 5, null)]);
    expect(gaps([ok(0), ok(1)], 0, 2)).toEqual([]);
  });

  it('does not count the time before sampling ever started, or after now', () => {
    expect(gaps([ok(5), ok(6)], 0, 6)).toEqual([]);
    expect(gaps([ok(0), failed(1)], 0, 10, 2)).toEqual([gap(0, 2, 'broker_unreachable')]);
  });

  it('judges old runs by the interval they ran at, so lowering it opens no gaps in old history', () => {
    const hourly = 60 * MIN;
    expect(gaps([ok(0, hourly), ok(60, hourly), ok(120, hourly), ok(121), ok(122)], 0, 122)).toEqual([]);
  });

  it('still finds runs missing at the interval they ran at, after the interval changed', () => {
    const hourly = 60 * MIN;
    expect(gaps([ok(0, hourly), ok(60, hourly), ok(300, hourly), ok(301), ok(302)], 0, 302)).toEqual([gap(60, 300, null)]);
  });

  it('does not count the wait for the first run at a raised interval as a gap', () => {
    const hourly = 60 * MIN;
    expect(gaps([ok(0), ok(1), ok(61, hourly), ok(121, hourly)], 0, 121)).toEqual([]);
  });

  it('does not judge a run from before intervals were stored, but still shows its failures', () => {
    expect(gaps([ok(0, null), ok(1, null), ok(600, null), ok(1200, null)], 0, 1200)).toEqual([]);
    expect(gaps([ok(0, null), failed(1), ok(2, null)], 0, 2)).toEqual([gap(0, 2, 'broker_unreachable')]);
  });

  it('clips a gap to the range, using the runs just outside it', () => {
    expect(gaps([ok(0), failed(1), failed(2), failed(3), ok(4)], 2, 3)).toEqual([gap(2, 3, 'broker_unreachable')]);
  });
});
