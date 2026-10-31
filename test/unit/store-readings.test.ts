// What the metrics show from the audit store: read in the background, never at a scrape.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { StoreReadings } from '../../src/server/metrics/store-readings.js';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<T>((res, rej) => ((resolve = res), (reject = rej)));
  return { promise, resolve, reject };
}

describe('StoreReadings', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('reads nothing until started, and has no value before its first reading', async () => {
    const read = vi.fn(async () => 1);
    const readings = new StoreReadings({ read, intervalMs: 1000, onError: () => {} });
    await readings.refresh();
    expect(read).not.toHaveBeenCalled();
    expect(readings.current()).toBeNull();
  });

  it('answers from memory with a reading in progress, and takes the new value when it ends', async () => {
    const answers = [deferred<number>(), deferred<number>()];
    let n = 0;
    const readings = new StoreReadings({ read: () => answers[n++]!.promise, intervalMs: 60_000, onError: () => {} });
    const started = readings.start();
    answers[0]!.resolve(1);
    await started;
    const refreshed = readings.refresh();
    expect(readings.current()).toBe(1);
    answers[1]!.resolve(2);
    await refreshed;
    expect(readings.current()).toBe(2);
    await readings.stop();
  });

  it('keeps the last value and reports a failed reading', async () => {
    let n = 0;
    const errors: unknown[] = [];
    const read = async () => {
      if (n++ > 0) throw new Error('store gone');
      return 1;
    };
    const readings = new StoreReadings({ read, intervalMs: 60_000, onError: (err) => errors.push(err) });
    await readings.start();
    await expect(readings.refresh()).resolves.toBeUndefined();
    expect(readings.current()).toBe(1);
    expect(errors).toEqual([expect.objectContaining({ message: 'store gone' })]);
    await readings.stop();
  });

  it('gives whoever asks during a reading one that began after they asked', async () => {
    const answers = [deferred<number>(), deferred<number>()];
    let n = 0;
    const read = vi.fn(() => answers[n++]!.promise);
    const readings = new StoreReadings({ read, intervalMs: 60_000, onError: () => {} });
    const started = readings.start();
    const asked = [readings.refresh(), readings.refresh()];
    answers[0]!.resolve(1);
    await started;
    await vi.waitFor(() => expect(read).toHaveBeenCalledTimes(2));
    answers[1]!.resolve(2);
    await Promise.all(asked);
    expect(readings.current()).toBe(2);
    await readings.stop();
  });

  it('reads again every interval, until stopped, and stop waits for the reading in progress', async () => {
    vi.useFakeTimers();
    let value = 0;
    const read = vi.fn(async () => ++value);
    const readings = new StoreReadings({ read, intervalMs: 1000, onError: () => {} });
    await readings.start();
    await vi.advanceTimersByTimeAsync(2000);
    expect(readings.current()).toBe(3);
    await readings.stop();
    await vi.advanceTimersByTimeAsync(5000);
    expect(read).toHaveBeenCalledTimes(3);
    expect(readings.current()).toBe(3);
  });
});
