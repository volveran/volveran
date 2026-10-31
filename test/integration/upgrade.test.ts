// The current version on a real store and profiles file of every release
// (test/fixtures/upgrade/): nothing here is simulated, so a migration or a
// profile parser that breaks an old release's data fails here.
import { readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { repoRoot } from '../../scripts/test-broker-env.mjs';
import { copyAuditStore } from '../../src/server/audit/copy-audit-store.js';
import { copyFixtureStore, RELEASED_VERSIONS, upgradeFixtures } from '../support/upgrade-fixtures.js';
import { fixtureAppOptions, upgradeChecks } from '../support/upgrade-checks.js';
import { makeTempDir, startApp, type TestApp } from './harness.js';
import { storeEnv } from './test-store.js';
import { product } from '../../src/shared/product.js';

// On PostgreSQL the same checks run after `copy-audit-store` moved the fixture there, so a
// store of any release is proved to work the same after the move.
describe.each(upgradeFixtures)('upgrading from $version', (fixture) => {
  let app: TestApp;
  let dataDir: string;
  beforeEach(async () => {
    dataDir = await makeTempDir('upgrade');
    await copyFixtureStore(fixture.version, dataDir);
    const store = await storeEnv(dataDir);
    if (store) await copyAuditStore({ dataDir, postgresUrl: store.env.VOLVERAN_POSTGRES_URL!, tls: null });
    app = await startApp(await fixtureAppOptions(fixture, dataDir));
  });
  afterEach(async () => {
    await app?.close();
    await rm(dataDir, { recursive: true, force: true });
  });
  upgradeChecks(fixture, () => app);
});

it('has a fixture for every release in the changelog but the current version', async () => {
  // A release gets its fixture once its image is published, before the next version bump.
  const changelog = await readFile(path.join(repoRoot, 'CHANGELOG.md'), 'utf8');
  const released = [...changelog.matchAll(/^## \[(\d[^\]]*)\]/gm)].map((m) => m[1]!).filter((v) => v !== product.version);
  expect(released.filter((v) => !(RELEASED_VERSIONS as readonly string[]).includes(v))).toEqual([]);
});
