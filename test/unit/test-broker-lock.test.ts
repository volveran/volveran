// The optional lock that keeps broker and database suites of several checkouts serial.
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { acquireLock } from '../../scripts/test-broker-lock.mjs';

describe('the test broker lock', () => {
  let dir: string;
  let file: string;
  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'broker-lock-'));
    file = path.join(dir, 'suites.lock');
  });
  afterEach(() => rm(dir, { recursive: true, force: true }));

  it('makes a second holder wait until the first releases', async () => {
    const release = await acquireLock(file, { pollMs: 5 });
    let second = false;
    const waiting = acquireLock(file, { pollMs: 5 }).then((releaseSecond) => {
      second = true;
      return releaseSecond;
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(second).toBe(false);
    release();
    (await waiting)();
    expect(second).toBe(true);
  });

  it('takes over from a holder that is gone', async () => {
    await writeFile(file, '999999999');
    const release = await acquireLock(file, { pollMs: 5 });
    expect(await readFile(file, 'utf8')).toBe(String(process.pid));
    release();
  });

  it('takes a file that names no process, such as an empty one', async () => {
    await writeFile(file, '');
    (await acquireLock(file, { pollMs: 5 }))();
  });

  it('removes the file on release, once', async () => {
    const release = await acquireLock(file, { pollMs: 5 });
    release();
    const next = await acquireLock(file, { pollMs: 5 });
    release();
    expect(await readFile(file, 'utf8')).toBe(String(process.pid));
    next();
  });
});
