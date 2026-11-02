// A real upgrade between two published images, following docs/upgrading-to-1.0.md: the old image
// (VOLVERAN_UPGRADE_FROM, by default 0.5.1) plays the fixture scenario against the test broker on
// a Docker volume and stops, then the new one (VOLVERAN_UPGRADE_TO) starts on that volume and
// profiles file, and on a PostgreSQL that `copy-audit-store` filled from a copy of it. The checks
// are upgradeChecks, through the HTTP API inside the container. See vitest.upgrade.config.ts.
import { execFileSync, spawnSync } from 'node:child_process';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { repoRoot, testBrokerSettings } from '../../scripts/test-broker-env.mjs';
import { eventually, fixtureQueues, purgeQueues } from '../broker/client.js';
import type { TestApp } from '../integration/harness.js';
import { upgradeChecks } from '../support/upgrade-checks.js';
import { createTestDatabase, type TestDatabase } from '../support/test-postgres.js';
import { fixtureEnv, upgradeFixtures } from '../support/upgrade-fixtures.js';
import { playScenario, profilesFile, REQUEST, scenarioEnv } from './generate-fixture.js';

const from = process.env.VOLVERAN_UPGRADE_FROM || '0.5.1';
const to = process.env.VOLVERAN_UPGRADE_TO;
if (!to) throw new Error('Set VOLVERAN_UPGRADE_TO to the published version to upgrade to');
const fixture = upgradeFixtures.find((f) => f.version === from);
if (!fixture) throw new Error(`${from} is not in RELEASED_VERSIONS`);
const imageOf = (version: string) => `ghcr.io/volveran/volveran:${version}`;

const id = `${process.pid}`;
const volume = `volveran-upgrade-${id}`;
const copyVolume = `volveran-upgrade-copy-${id}`;
const containers: string[] = [];
let work: string;
let network: string;

const docker = (...args: string[]) => execFileSync('docker', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
const envArgs = (env: Record<string, string>) => Object.entries(env).flatMap(([k, v]) => ['-e', `${k}=${v}`]);

/** Starts `version` in the broker's network, on this data volume and the scenario's profiles file. */
function start(version: string, name: string, dataVolume: string, env: Record<string, string>): string {
  const container = `volveran-upgrade-${name}-${id}`;
  containers.push(container);
  docker('run', '-d', '--name', container, '--network', network, '-v', `${dataVolume}:/data`, '-v', `${path.join(work, 'profiles.yaml')}:/config/profiles.yaml:ro`, ...envArgs(env), imageOf(version));
  return container;
}

/** What upgradeChecks needs of an app, answered from inside the container, as a Solo Mode release listens on its loopback. */
function appIn(container: string) {
  const request = (method: string) => async (urlPath: string, body?: unknown) => {
    const out = docker('exec', container, 'node', '-e', REQUEST, `http://127.0.0.1:8080${urlPath}`, method, body === undefined ? '' : JSON.stringify(body));
    const newline = out.indexOf('\n');
    const text = out.slice(newline + 1).trim();
    return { status: Number(out.slice(0, newline)), body: text ? JSON.parse(text) : undefined };
  };
  return { get: request('GET'), post: request('POST') } as unknown as TestApp;
}

/** Waits until the release answers, and shows its log if it never does. */
async function untilServing(container: string) {
  const app = appIn(container);
  try {
    await eventually(async () => {
      const res = await app.get('/api/session');
      if (res.status !== 200) throw new Error(`/api/session answered ${res.status}`);
    }, 60_000, 1000);
  } catch (err) {
    console.error(spawnSync('docker', ['logs', container], { encoding: 'utf8' }).stderr);
    throw err;
  }
}

function stop(container: string) {
  docker('stop', '-t', '30', container);
  expect(docker('inspect', '--format', '{{.State.ExitCode}}', container).trim()).toBe('0');
}

const storeHash = (dataVolume: string) =>
  docker('run', '--rm', '--user', '0', '-v', `${dataVolume}:/data:ro`, '--entrypoint', 'sh', imageOf(to), '-c', 'cd /data && sha256sum * | sort');

beforeAll(async () => {
  work = await mkdtemp(path.join(tmpdir(), 'volveran-upgrade-'));
  await chmod(work, 0o755);
  await writeFile(path.join(work, 'profiles.yaml'), profilesFile(fixture));
  await chmod(path.join(work, 'profiles.yaml'), 0o644);
  const { project } = testBrokerSettings(repoRoot, process.env);
  network = `container:${execFileSync('docker', ['compose', '-p', project, 'ps', '-q', 'rabbitmq'], { encoding: 'utf8' }).trim()}`;
  docker('volume', 'create', volume);
  docker('volume', 'create', copyVolume);
  await purgeQueues('/', fixtureQueues);

  const old = start(from, 'old', volume, scenarioEnv());
  await playScenario(old, fixture);
  stop(old);
  docker('rm', old);
  // PostgreSQL's run needs the store as the old release left it, as SQLite's run migrates this one.
  docker('run', '--rm', '--user', '0', '-v', `${volume}:/from:ro`, '-v', `${copyVolume}:/to`, '--entrypoint', 'sh', imageOf(to), '-c', 'cp -a /from/. /to/');
});

afterAll(async () => {
  for (const c of containers) spawnSync('docker', ['rm', '-f', '-v', c], { stdio: 'ignore' });
  spawnSync('docker', ['volume', 'rm', volume, copyVolume], { stdio: 'ignore' });
  await purgeQueues('/', fixtureQueues);
  await rm(work, { recursive: true, force: true });
});

describe(`check-config of ${to}, as the guide gives it`, () => {
  const checkConfig = (file: string) =>
    spawnSync('docker', ['run', '--rm', '--read-only', '-v', `${file}:/config/profiles.yaml:ro`, '-e', 'VOLVERAN_OPERATOR=ci', ...envArgs({ VOLVERAN_FIXTURE_PASSWORD: 'x', VOLVERAN_FIXTURE_WEBHOOK_URL: 'http://127.0.0.1:9/' }), imageOf(to), 'node', 'dist/server/main.js', 'check-config'], { encoding: 'utf8' });

  it(`passes the profiles file of ${from}`, () => {
    const result = checkConfig(path.join(work, 'profiles.yaml'));
    expect([result.status, result.stderr]).toEqual([0, expect.any(String)]);
  });

  it('refuses a misspelt key, in the words of the guide', async () => {
    const file = path.join(work, 'misspelt.yaml');
    await writeFile(file, profilesFile(fixture).replace('protected: false', 'protekted: true'));
    await chmod(file, 0o644);
    const result = checkConfig(file);
    expect(result.status).toBe(1);
    expect(result.stdout + result.stderr).toContain('profiles[0] ("fixture").protekted is not a key of a Broker Profile');
  });
});

describe(`${to} on the SQLite store and profiles file of ${from}`, () => {
  let container: string;
  beforeAll(async () => {
    container = start(to, 'sqlite', volume, fixtureEnv());
    await untilServing(container);
  });

  upgradeChecks(fixture, () => appIn(container));

  it('warns of the profiles file with no version', () => {
    const { stdout, stderr } = spawnSync('docker', ['logs', container], { encoding: 'utf8' });
    expect(stdout + stderr).toContain('The profiles file has no version; it is read as version 1');
  });

  it('stops cleanly, starts again, and still has the Audit Entries', async () => {
    stop(container);
    docker('start', container);
    await untilServing(container);
    const { body } = await appIn(container).get('/api/audit-entries?messageId=fixture-discarded');
    expect(body.entries.map((e: any) => e.action).sort()).toEqual(['discard', 'restore']);
    stop(container);
  });

  it('is refused by 0.6.1 afterwards, in the words of the guide', () => {
    const result = spawnSync('docker', ['run', '--rm', '-v', `${volume}:/data`, '-v', `${path.join(work, 'profiles.yaml')}:/config/profiles.yaml:ro`, ...envArgs(fixtureEnv()), imageOf('0.6.1')], { encoding: 'utf8', timeout: 60_000 });
    expect(result.status).toBe(1);
    expect(result.stdout + result.stderr).toContain('The audit store is at schema version 18, newer than this version of Volverán understands (17). Downgrades are not supported');
  });
});

describe(`${to} on PostgreSQL, after copy-audit-store from the store of ${from}`, () => {
  let database: TestDatabase;
  let url: string;
  let container: string;
  beforeAll(async () => {
    database = await createTestDatabase();
    // The app shares the broker's network, where PostgreSQL has its compose name.
    url = database.url.replace(/@127\.0\.0\.1:\d+\//, '@postgres:5432/');
  });
  afterAll(async () => {
    if (container) spawnSync('docker', ['rm', '-f', '-v', container], { stdio: 'ignore' });
    await database?.drop();
  });

  it('copies as the guide gives it, says OK, and leaves the source as it was', () => {
    const before = storeHash(copyVolume);
    const result = spawnSync('docker', ['run', '--rm', '--network', network, '-v', `${copyVolume}:/data:ro`, '-e', `VOLVERAN_POSTGRES_URL=${url}`, imageOf(to), 'node', 'dist/server/main.js', 'copy-audit-store'], { encoding: 'utf8' });
    console.log(result.stdout, result.stderr);
    expect(result.status).toBe(0);
    expect(result.stdout).toMatch(/\bOK\b/);
    expect(result.stdout + result.stderr).not.toContain('volveran-test-pass');
    expect(storeHash(copyVolume)).toBe(before);
  });

  describe('then starts with the URL set', () => {
    beforeAll(async () => {
      container = start(to, 'postgres', copyVolume, { ...fixtureEnv(), VOLVERAN_POSTGRES_URL: url });
      await untilServing(container);
    });
    upgradeChecks(fixture, () => appIn(container));
  });
});
