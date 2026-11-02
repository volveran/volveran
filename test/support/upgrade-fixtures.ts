// The upgrade fixtures: test/fixtures/upgrade/<version>/ holds the audit store
// and the profiles file one released image really wrote and read, made by
// test/upgrade/generate-fixture.ts running that image through the scenario
// below. They contain only this scenario's made-up data: passwords and webhook
// URLs stay in the environment. This file says what is in them, for the tests
// and the generator alike, and imports nothing that needs a broker.
import { cp, readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { repoRoot } from '../../scripts/test-broker-env.mjs';

/** Every released version, oldest first, a pre-release in the form of its tag (`1.0.0-rc.1`). Add a new release here, then generate its fixture. */
export const RELEASED_VERSIONS = ['0.1.0', '0.2.0', '0.3.0', '0.4.0', '0.5.0', '0.5.1', '0.6.0', '0.6.1'] as const;

export type ReleasedVersion = (typeof RELEASED_VERSIONS)[number];

export interface UpgradeFixture {
  version: ReleasedVersion;
  /** The release has Roles (0.3), so its profiles file can map them. */
  hasRoles: boolean;
  /** The release has Replay Rules (0.4), so its store has their state. */
  hasReplayRules: boolean;
  /** The release has Alert Destinations (0.5), so its store has their tables and a test notification. */
  hasNotifications: boolean;
}

/** Whether `version` is 0.`minor` or later. Every 1.x is, whatever its own minor version. */
export const atLeast = (version: string, minor: number) => {
  const [major = 0, min = 0] = version.split('.').map(Number);
  return major > 0 || min >= minor;
};

/**
 * The releases in the changelog that should have a fixture and have none. The version being
 * prepared has no image yet. A pre-release needs none, though it may have one: nothing promises an
 * upgrade from it (docs/compatibility.md), and the release it leads to gets its own.
 */
export function releasesWithoutFixture(changelog: string, current: string, fixtures: readonly string[] = RELEASED_VERSIONS): string[] {
  return [...changelog.matchAll(/^## \[(\d[^\]]*)\]/gm)]
    .map((m) => m[1]!)
    .filter((version) => version !== current && !version.includes('-') && !fixtures.includes(version));
}

export const upgradeFixtures: UpgradeFixture[] = RELEASED_VERSIONS.map((version) => ({
  version,
  hasRoles: atLeast(version, 3),
  hasReplayRules: atLeast(version, 4),
  hasNotifications: atLeast(version, 5),
}));

/** The Solo Mode Operator every fixture's entries are recorded as. */
export const FIXTURE_OPERATOR = 'fixture-operator';
export const FIXTURE_PROFILE = 'fixture';
export const FIXTURE_QUEUE = 'orders.dlq';
/** Where the Move of the scenario sends its Message. */
export const FIXTURE_MOVE_QUEUE = 'triage.manual';
export const FIXTURE_DISCARD_REASON = 'fixture duplicate order';
export const FIXTURE_PAUSE_REASON = 'fixture paused for maintenance';
export const FIXTURE_PAUSED_RULE = 'fixture-paused';
export const FIXTURE_RUNNING_RULE = 'fixture-running';
export const FIXTURE_DESTINATION = 'fixture-webhook';

/** The Messages of the scenario, by `message_id`. Each keeps its Discarded body byte for byte. */
export const fixtureMessages = {
  /** Discarded and left there: the current version can still Restore it. */
  discarded: { id: 'fixture-discarded', body: Buffer.from('{"order":"fixture-discarded"}'), contentType: 'application/json' },
  /** Discarded and left there, with a body that is not text. */
  binary: { id: 'fixture-binary', body: Buffer.from([0x00, 0xff, 0x01, 0xfe]), contentType: 'application/octet-stream' },
  /** Discarded, then Restored by the release that wrote the store. */
  restored: { id: 'fixture-restored', body: Buffer.from('{"order":"fixture-restored"}'), contentType: 'application/json' },
  moved: { id: 'fixture-moved', body: Buffer.from('{"order":"fixture-moved"}'), contentType: 'application/json' },
  /** Dead-lettered for real, so it can be Replayed. */
  replayed: { id: 'fixture-replayed', body: Buffer.from('{"order":"fixture-replayed"}'), contentType: 'application/json' },
};

/** A header on every seeded Message, to check that Discarded headers survive. */
export const FIXTURE_HEADER = { 'x-fixture': 'kept' };

/** The environment a fixture's profiles file names. The password is the test broker's, from test/broker/definitions.json. */
export const fixtureEnv = (webhookUrl = 'http://127.0.0.1:9/fixture') => ({
  VOLVERAN_OPERATOR: FIXTURE_OPERATOR,
  VOLVERAN_FIXTURE_PASSWORD: 'volveran-admin-pass',
  VOLVERAN_FIXTURE_WEBHOOK_URL: webhookUrl,
});

export const fixtureDir = (version: string) => path.join(repoRoot, 'test/fixtures/upgrade', version);

/**
 * The checked-in profiles file names the broker as these, so it does not change
 * with the test broker's random ports; `fixtureProfilesYaml` swaps in the real ones.
 */
export const FIXTURE_MANAGEMENT_URL = 'http://localhost:15672';
export const FIXTURE_AMQP_URL = 'amqp://localhost:5672';

/** A fixture's profiles file as written by its release, pointing at `broker`. */
export function pointAtBroker(yaml: string, broker: { managementUrl: string; amqpUrl: string }): string {
  return yaml.replaceAll(FIXTURE_MANAGEMENT_URL, broker.managementUrl).replaceAll(FIXTURE_AMQP_URL, broker.amqpUrl);
}

export async function fixtureProfilesYaml(version: string, broker: { managementUrl: string; amqpUrl: string }): Promise<string> {
  return pointAtBroker(await readFile(path.join(fixtureDir(version), 'profiles.yaml'), 'utf8'), broker);
}

/** Copies a fixture's audit store into the data directory `dataDir`; a test must never open the checked-in file. */
export async function copyFixtureStore(version: string, dataDir: string): Promise<void> {
  const from = fixtureDir(version);
  for (const file of await readdir(from)) {
    if (file !== 'profiles.yaml') await cp(path.join(from, file), path.join(dataDir, file));
  }
}
