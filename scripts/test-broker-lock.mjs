// A lock file for `test-broker.mjs run`, so the broker and database suites of several
// checkouts take turns (VOLVERAN_TEST_LOCK_FILE; see CONTRIBUTING.md). The file exists while
// it is held and names the holder's pid, so a holder that was killed does not block anyone.
// Two waiters that find a dead holder at the same instant could both get in: this is for a
// developer's machine, not for anything that must be exact.
import { readFileSync, rmSync, writeFileSync } from 'node:fs';

/** @param {number} pid */
const isAlive = (pid) => {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return /** @type {NodeJS.ErrnoException} */ (err).code === 'EPERM';
  }
};

/** @param {string} file */
function readHolder(file) {
  try {
    const text = readFileSync(file, 'utf8').trim();
    return text === '' ? null : Number(text);
  } catch (err) {
    if (/** @type {NodeJS.ErrnoException} */ (err).code === 'ENOENT') return undefined;
    throw err;
  }
}

/**
 * Waits for the lock and returns the function that releases it.
 * @param {string} file
 * @param {{ pollMs?: number }} [options]
 */
export async function acquireLock(file, { pollMs = 1000 } = {}) {
  let announced = false;
  for (;;) {
    try {
      writeFileSync(file, String(process.pid), { flag: 'wx' });
      let held = true;
      return () => {
        if (held) rmSync(file, { force: true });
        held = false;
      };
    } catch (err) {
      if (/** @type {NodeJS.ErrnoException} */ (err).code !== 'EEXIST') throw err;
    }
    const holder = readHolder(file);
    if (holder === null || (holder !== undefined && !isAlive(holder))) {
      rmSync(file, { force: true });
      continue;
    }
    if (!announced) console.error(`[test-broker] waiting for the lock ${file}, held by pid ${holder}`);
    announced = true;
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
}
