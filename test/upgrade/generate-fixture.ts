// Makes one upgrade fixture: runs a released image against the test broker,
// plays the scenario through its HTTP API and checks in what it wrote.
//
//   npm run fixture:upgrade -- 0.5.1
//
// Only ever talks to the release through its API, as an Operator would, so the
// store holds exactly what that release writes.
import { execFile, execFileSync, spawnSync } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { stringify } from 'yaml';
import { repoRoot, testBrokerSettings } from '../../scripts/test-broker-env.mjs';
import {
  deadLetter,
  deadLetterRoutes,
  eventually,
  fixtureQueues,
  purgeQueues,
  withChannel,
} from '../broker/client.js';
import {
  FIXTURE_AMQP_URL,
  FIXTURE_DESTINATION,
  FIXTURE_DISCARD_REASON,
  FIXTURE_HEADER,
  FIXTURE_MANAGEMENT_URL,
  FIXTURE_MOVE_QUEUE,
  FIXTURE_OPERATOR,
  FIXTURE_PAUSED_RULE,
  FIXTURE_PAUSE_REASON,
  FIXTURE_PROFILE,
  FIXTURE_QUEUE,
  FIXTURE_RUNNING_RULE,
  fixtureDir,
  fixtureEnv,
  fixtureMessages,
  upgradeFixtures,
  type UpgradeFixture,
} from '../support/upgrade-fixtures.js';

const execFileAsync = promisify(execFile);
const RULE_QUEUE = 'payments.dlq';
/** Where the test notification goes, inside the image's container. */
const WEBHOOK_PORT = 39999;

function profilesFile(fixture: UpgradeFixture): string {
  const minor = Number(fixture.version.split('.')[1]);
  const rule = (name: string) => ({
    name,
    vhost: '/',
    queue: RULE_QUEUE,
    filter: { kind: 'header', name: 'transient' },
    every: '24h',
    backoff: { initial: '10m', max: '1h' },
    maxAttempts: 5,
    stopWhen: { diedAgain: 5, within: '15m' },
  });
  return stringify({
    ...(fixture.hasNotifications && {
      alertDestinations: [{ name: FIXTURE_DESTINATION, type: 'webhook', urlEnv: 'VOLVERAN_FIXTURE_WEBHOOK_URL' }],
    }),
    profiles: [
      {
        name: FIXTURE_PROFILE,
        managementUrl: FIXTURE_MANAGEMENT_URL,
        amqpUrl: FIXTURE_AMQP_URL,
        username: 'volveran-admin',
        passwordEnv: 'VOLVERAN_FIXTURE_PASSWORD',
        vhosts: 'all',
        defaultQueueFilter: '*.dlq',
        protected: false,
        ...(minor >= 3 && { roles: { admin: ['fixture-admins'] } }),
        ...(fixture.hasReplayRules && {
          replayRate: { default: 100, max: 100 },
          canary: { watchWindow: '30s' },
          replayRules: [rule(FIXTURE_PAUSED_RULE), rule(FIXTURE_RUNNING_RULE)],
        }),
        ...(fixture.hasNotifications && {
          alerts: [
            {
              name: 'fixture-deep',
              destinations: [FIXTURE_DESTINATION],
              when: { vhost: '/', queue: FIXTURE_QUEUE, depthAbove: 1_000_000 },
            },
          ],
        }),
      },
    ],
  });
}

type Call = (method: string, urlPath: string, body?: unknown) => Promise<any>;

// A Solo Mode release listens only on its own loopback, and the host may be
// rootless Docker, whose host network is not the host's. So the image shares the
// network of the test broker's container, where the checked-in URLs are simply
// true, and requests are made from inside it.
const REQUEST = `const [url, method, body] = process.argv.slice(1);
fetch(url, { method, headers: body ? { 'content-type': 'application/json' } : {}, body: body || undefined })
  .then(async (r) => console.log(r.status + '\\n' + (await r.text())));`;

const WEBHOOK = `require('node:http').createServer((req, res) => { req.resume(); req.on('end', () => res.writeHead(204).end()); }).listen(${WEBHOOK_PORT}, '127.0.0.1');`;

function client(container: string): Call {
  return async (method, urlPath, body) => {
    const args = ['exec', container, 'node', '-e', REQUEST, `http://127.0.0.1:8080${urlPath}`, method, body === undefined ? '' : JSON.stringify(body)];
    const { stdout } = await execFileAsync('docker', args);
    const newline = stdout.indexOf('\n');
    const status = Number(stdout.slice(0, newline));
    const text = stdout.slice(newline + 1).trim();
    if (status < 200 || status >= 300) throw new Error(`${method} ${urlPath} answered ${status}: ${text}`);
    return text ? JSON.parse(text) : undefined;
  };
}

async function seedDirect() {
  await withChannel('/', async (ch) => {
    for (const m of [fixtureMessages.discarded, fixtureMessages.binary, fixtureMessages.restored, fixtureMessages.moved]) {
      ch.sendToQueue(FIXTURE_QUEUE, m.body, { messageId: m.id, contentType: m.contentType, persistent: true, headers: FIXTURE_HEADER });
    }
    await ch.waitForConfirms();
  });
  const m = fixtureMessages.replayed;
  await deadLetter(deadLetterRoutes.classic, [
    { body: m.body, options: { messageId: m.id, contentType: m.contentType, headers: FIXTURE_HEADER } },
  ]);
}

async function playMessages(call: Call) {
  const { checkout } = await call('POST', `/api/profiles/${FIXTURE_PROFILE}/vhosts/%2F/queues/${FIXTURE_QUEUE}/checkouts`, {});
  const decide = (message: { id: string }, decision: unknown) => {
    const held = checkout.messages.find((m: any) => m.messageId === message.id);
    if (!held) throw new Error(`${message.id} is not in the Checkout`);
    return call('POST', `/api/checkouts/${checkout.id}/decisions`, { handles: [held.handle], decision });
  };
  const discard = { kind: 'discard', reason: FIXTURE_DISCARD_REASON };
  await decide(fixtureMessages.discarded, discard);
  await decide(fixtureMessages.binary, discard);
  await decide(fixtureMessages.restored, discard);
  await decide(fixtureMessages.moved, { kind: 'move', destination: { queue: FIXTURE_MOVE_QUEUE } });
  await decide(fixtureMessages.replayed, { kind: 'replay' });
  await call('POST', `/api/checkouts/${checkout.id}/apply`, { confirm: true });
  // Since 0.4 an Apply answers at once and runs on.
  const ended = await eventually(async () => {
    const view = (await call('GET', `/api/checkouts/${checkout.id}`)).checkout;
    if (view.status !== 'ended') throw new Error(`Checkout is ${view.status}`);
    return view;
  }, 60_000);
  if (ended.endReason !== 'applied') throw new Error(`The Apply ended as ${ended.endReason}`);

  const { entries } = await call('GET', `/api/audit-entries?messageId=${fixtureMessages.restored.id}`);
  const restored = await call('POST', `/api/audit-entries/${entries[0].id}/restore`, { confirm: true });
  if (restored.entry.outcome !== 'done') throw new Error(`The Restore ended as ${restored.entry.outcome}`);
}

async function playRules(call: Call) {
  await withChannel('/', async (ch) => {
    const time = { '!': 'timestamp', value: Math.floor((Date.now() - 2 * 3_600_000) / 1000) };
    ch.sendToQueue(RULE_QUEUE, Buffer.from('fixture rule pass'), {
      messageId: 'fixture-rule-pass',
      persistent: true,
      headers: {
        transient: 'yes',
        'x-death': [{ queue: 'payments.work', reason: 'rejected', count: 1, time, exchange: 'payments', 'routing-keys': ['payments.captured'] }],
      },
    });
    await ch.waitForConfirms();
  });
  const { pass } = await call('POST', `/api/profiles/${FIXTURE_PROFILE}/replay-rules/${FIXTURE_RUNNING_RULE}/run`, {});
  if (pass.summary?.replayed !== 1) throw new Error(`The Rule Pass did not Replay its Message: ${JSON.stringify(pass)}`);
  await call('POST', `/api/profiles/${FIXTURE_PROFILE}/replay-rules/${FIXTURE_PAUSED_RULE}/pause`, { reason: FIXTURE_PAUSE_REASON });
}

async function generate(fixture: UpgradeFixture) {
  const image = `ghcr.io/volveran/volveran:${fixture.version}`;
  const work = await mkdtemp(path.join(tmpdir(), `volveran-fixture-${fixture.version}-`));
  const yaml = profilesFile(fixture);
  const profiles = path.join(work, 'profiles.yaml');
  await writeFile(profiles, yaml);
  // Readable by the image's user, whatever it maps to on this host.
  await chmod(work, 0o755);
  await chmod(profiles, 0o644);

  const { project } = testBrokerSettings(repoRoot, process.env);
  const broker = execFileSync('docker', ['compose', '-p', project, 'ps', '-q', 'rabbitmq'], { encoding: 'utf8' }).trim();
  const container = `volveran-fixture-${fixture.version.replaceAll('.', '-')}-${process.pid}`;
  const env = fixtureEnv(`http://127.0.0.1:${WEBHOOK_PORT}/`);
  await purgeQueues('/', fixtureQueues);
  execFileSync('docker', [
    'run', '-d', '--name', container, '--network', `container:${broker}`,
    '-v', `${profiles}:/config/profiles.yaml:ro`,
    ...Object.entries(env).flatMap(([k, v]) => ['-e', `${k}=${v}`]),
    image,
  ], { stdio: ['ignore', 'ignore', 'inherit'] });

  try {
    const call = client(container);
    await eventually(() => call('GET', '/api/session'), 60_000, 1000);
    await seedDirect();
    await playMessages(call);
    if (fixture.hasReplayRules) await playRules(call);
    if (fixture.hasNotifications) {
      execFileSync('docker', ['exec', '-d', container, 'node', '-e', WEBHOOK]);
      const { delivery } = await eventually(() => call('POST', `/api/alert-destinations/${FIXTURE_DESTINATION}/test`, {}).then((r) => {
        if (r.delivery.outcome !== 'delivered') throw new Error(`The test notification ended as ${r.delivery.outcome}`);
        return r;
      }));
      console.log(`test notification ${delivery.outcome}`);
    }
    // A clean stop, so the store is what a stopped release leaves behind.
    execFileSync('docker', ['stop', '-t', '30', container], { stdio: 'ignore' });
    const state = JSON.parse(execFileSync('docker', ['inspect', '--format', '{{json .State}}', container], { encoding: 'utf8' }));
    if (state.ExitCode !== 0) throw new Error(`The release exited with ${state.ExitCode}`);

    const out = fixtureDir(fixture.version);
    await rm(out, { recursive: true, force: true });
    await mkdir(out, { recursive: true });
    await writeFile(path.join(out, 'profiles.yaml'), yaml);
    execFileSync('docker', ['cp', `${container}:/data/.`, out]);
    console.log(`${image} wrote ${(await readdir(out)).join(', ')} as ${FIXTURE_OPERATOR}`);
  } catch (err) {
    spawnSync('docker', ['logs', '--tail', '50', container], { stdio: 'inherit' });
    throw err;
  } finally {
    spawnSync('docker', ['rm', '-f', '-v', container], { stdio: 'ignore' });
    await purgeQueues('/', fixtureQueues);
    await rm(work, { recursive: true, force: true });
  }
}

const version = process.argv[2];
const fixture = upgradeFixtures.find((f) => f.version === version);
if (!fixture) {
  console.error(`usage: npm run fixture:upgrade -- <version>: ${version ?? 'no version'} is not in RELEASED_VERSIONS (test/support/upgrade-fixtures.ts)`);
  process.exit(2);
}
await generate(fixture);
process.exit(0);
