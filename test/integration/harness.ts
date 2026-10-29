// Integration test harness: starts Volverán in-process against this
// checkout's test broker and drives its HTTP API.
//
// The broker helpers (withChannel, seedMessages, management, ...) live in
// test/broker/client.ts, shared with the broker-facts suite, and are
// re-exported here so test files import everything from one place.
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import tls from 'node:tls';
import { stringify } from 'yaml';
import { repoRoot } from '../../scripts/test-broker-env.mjs';
import type { BodyRetention } from '../../src/server/audit/body-retention.js';
import type { CheckoutTestHooks } from '../../src/server/checkout/manager.js';
import { startServer } from '../../src/server/server.js';
import type { CheckoutLimits } from '../../src/server/triage/checkout-collection.js';
import type { CheckoutTiming } from '../../src/server/triage/checkout-timing.js';
import { brokerUsers, eventually, management, testBroker } from '../broker/client.js';

export * from '../broker/client.js';

/** The Operator name startApp configures unless a test overrides VOLVERAN_OPERATOR. */
export const testOperator = 'test-operator';

/** A Broker Profile as written in the profiles YAML file. */
export interface ProfileFixture {
  name: string;
  managementUrl?: string;
  amqpUrl?: string;
  caFile?: string;
  username?: string;
  passwordEnv?: string;
  vhosts?: 'all' | string[];
  defaultQueueFilter?: string;
  protected?: boolean;
  requireApproval?: boolean;
  /** `operatorToken`: connect with the signed-in Operator's access token (then no username or passwordEnv). */
  credentials?: 'shared' | 'operatorToken';
  tokenUsernameClaim?: string;
  /** Team Mode: the groups holding each Role on the profile. */
  roles?: Partial<Record<'viewer' | 'operator' | 'admin', unknown>>;
  /** The default and maximum Replay Rate, in Messages per second. */
  replayRate?: { default?: unknown; max?: unknown };
  /** Replay Rules, as written in the profiles file. */
  replayRules?: Array<Record<string, unknown>>;
  /** Canary Replay: the Watch Window, a duration such as `30s`. */
  canary?: { watchWindow?: unknown; requiredAbove?: unknown };
}

/**
 * A Broker Profile pointing at the test broker as volveran-admin. Its
 * password is read from VOLVERAN_TEST_PW_<NAME>, which startApp sets.
 */
export function testProfile(overrides: ProfileFixture): ProfileFixture {
  return {
    managementUrl: testBroker.managementUrl,
    amqpUrl: testBroker.amqpUrl,
    username: brokerUsers.admin.username,
    passwordEnv: passwordEnvFor(overrides.name),
    vhosts: 'all',
    ...overrides,
  };
}

function passwordEnvFor(profileName: string): string {
  return `VOLVERAN_TEST_PW_${profileName.toUpperCase().replace(/[^A-Z0-9]/g, '_')}`;
}

export interface TestResponse<T = any> {
  status: number;
  body: T;
}

export interface TestApp {
  baseUrl: string;
  get<T = any>(urlPath: string): Promise<TestResponse<T>>;
  post<T = any>(urlPath: string, body?: unknown): Promise<TestResponse<T>>;
  delete<T = any>(urlPath: string): Promise<TestResponse<T>>;
  close(): Promise<void>;
}

export interface StartAppOptions {
  profiles?: ProfileFixture[];
  /** Raw YAML to write as the profiles file instead of `profiles`. */
  rawYaml?: string;
  /**
   * The app's environment, on top of the defaults (VOLVERAN_OPERATOR =
   * testOperator and volveran-admin's password for every testProfile).
   * `undefined` removes a default.
   */
  env?: Record<string, string | undefined>;
  /** Listen address; default 127.0.0.1. */
  host?: string;
  /** Listen port; default 0 (a free port). Team Mode tests pick one first, for the redirect URL. */
  port?: number;
  checkoutLimits?: Partial<CheckoutLimits>;
  /** Time limit, heartbeat window and quorum backstop margin, in ms (tests use seconds, not the 30/2 minute defaults). */
  checkoutTiming?: Partial<CheckoutTiming>;
  endedCheckoutRetentionMs?: number;
  checkoutTestHooks?: CheckoutTestHooks;
  /** The audit store's directory (kept by the caller); default in memory. */
  dataDir?: string;
  /** Overrides the body retention limits and interval (ms) from the environment. */
  bodyRetention?: Partial<BodyRetention>;
  /** Collects the app's log lines (parsed JSON) here; default no logging. */
  logs?: Array<Record<string, any>>;
}

/**
 * Starts the app in-process on an ephemeral port (so worktrees never clash),
 * with a profiles file in a temp dir under .test-tmp/. `close` stops it and
 * removes the temp dir. The app's environment is `env` only, never
 * process.env.
 */
export async function startApp(options: StartAppOptions = {}): Promise<TestApp> {
  const profiles = options.profiles ?? [];
  const dir = await makeTempDir('app');
  const profilesFile = path.join(dir, 'profiles.yaml');
  await writeFile(profilesFile, options.rawYaml ?? stringify({ profiles }));

  const env: Record<string, string | undefined> = { VOLVERAN_OPERATOR: testOperator };
  for (const p of profiles) {
    if (p.passwordEnv === passwordEnvFor(p.name)) env[p.passwordEnv] = brokerUsers.admin.password;
  }
  Object.assign(env, options.env);

  let server;
  try {
    server = await startServer({
      profilesFile,
      env,
      host: options.host ?? '127.0.0.1',
      port: options.port ?? 0,
      checkoutLimits: options.checkoutLimits,
      checkoutTiming: options.checkoutTiming,
      endedCheckoutRetentionMs: options.endedCheckoutRetentionMs,
      checkoutTestHooks: options.checkoutTestHooks,
      dataDir: options.dataDir,
      bodyRetention: options.bodyRetention,
      logger: options.logs && { stream: { write: (line: string) => void options.logs!.push(JSON.parse(line)) } },
    });
  } catch (err) {
    await rm(dir, { recursive: true, force: true });
    throw err;
  }

  const request = async (method: string, urlPath: string, body?: unknown): Promise<TestResponse> => {
    const res = await fetch(server.url + urlPath, {
      method,
      headers: body === undefined ? {} : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : undefined };
  };

  return {
    baseUrl: server.url,
    get: (urlPath) => request('GET', urlPath),
    post: (urlPath, body) => request('POST', urlPath, body ?? {}),
    delete: (urlPath) => request('DELETE', urlPath),
    async close() {
      await server.close();
      await rm(dir, { recursive: true, force: true });
    },
  };
}

/** A fresh directory under .test-tmp/; the caller removes it. */
export async function makeTempDir(prefix: string): Promise<string> {
  const tmpRoot = path.join(repoRoot, '.test-tmp');
  await mkdir(tmpRoot, { recursive: true });
  return mkdtemp(path.join(tmpRoot, `${prefix}-`));
}

export interface SpawnServerOptions {
  /** Entry point relative to the repository root, e.g. `src/server/main.ts`. */
  script: string;
  /** Directory for the profiles file; also the audit store's data directory (`<dir>/data`) unless `dataDir` is given. */
  dir: string;
  dataDir?: string;
  /** Extra environment (VOLVERAN_OPERATOR, password variables, ...). */
  env: Record<string, string>;
  profiles: ProfileFixture[];
  /** How long to wait for "listening on" before killing the child (default 20 s). */
  timeoutMs?: number;
}

/**
 * Runs a server entry point as a child process with its own profiles file,
 * data directory and a random port; resolves with the child and its URL
 * once it listens. Never waits longer than `timeoutMs`: a child that has
 * not started by then is killed and the promise rejects with its output.
 */
export async function spawnServer(options: SpawnServerOptions): Promise<{ child: ChildProcess; url: string }> {
  const profilesFile = path.join(options.dir, 'profiles.yaml');
  await writeFile(profilesFile, stringify({ profiles: options.profiles }));
  const child = spawn(process.execPath, ['--import', 'tsx', options.script], {
    cwd: repoRoot,
    env: {
      PATH: process.env.PATH,
      VOLVERAN_PROFILES_FILE: profilesFile,
      VOLVERAN_PORT: '0',
      VOLVERAN_DATA_DIR: options.dataDir ?? path.join(options.dir, 'data'),
      ...options.env,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const timeoutMs = options.timeoutMs ?? 20_000;
  return new Promise((resolve, reject) => {
    let out = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`${options.script} did not start listening within ${timeoutMs} ms: ${out}`));
    }, timeoutMs);
    child.stdout!.on('data', (chunk: Buffer) => {
      out += chunk.toString();
      const url = /listening on (http:\/\/\S+)/.exec(out)?.[1];
      if (url) {
        clearTimeout(timer);
        resolve({ child, url });
      }
    });
    child.stderr!.on('data', (chunk: Buffer) => (out += chunk.toString()));
    child.on('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`${options.script} exited with ${code}: ${out}`));
    });
  });
}

/**
 * Test TLS material in test/fixtures/tls/: `ca.pem` is a private test CA and
 * `server.pem`/`server.key` a certificate it signed for localhost and
 * 127.0.0.1 (both valid until 2125; the CA key was thrown away).
 */
export const tlsFixtures = {
  caFile: path.join(repoRoot, 'test/fixtures/tls/ca.pem'),
  certFile: path.join(repoRoot, 'test/fixtures/tls/server.pem'),
  keyFile: path.join(repoRoot, 'test/fixtures/tls/server.key'),
};

/**
 * A TLS terminator on 127.0.0.1 in front of a plain TCP port of the test
 * broker (its management or AMQP port), with the test CA's certificate:
 * `https://127.0.0.1:<port>` or `amqps://127.0.0.1:<port>` then reaches the
 * broker over TLS. Returns the port and a function stopping the proxy.
 */
export async function startTlsProxy(targetPort: number): Promise<{ port: number; close(): Promise<void> }> {
  const [cert, key] = await Promise.all([readFile(tlsFixtures.certFile), readFile(tlsFixtures.keyFile)]);
  const sockets = new Set<net.Socket>();
  const server = tls.createServer({ cert, key }, (client) => {
    const upstream = net.connect(targetPort, '127.0.0.1');
    for (const s of [client, upstream]) {
      sockets.add(s);
      s.on('close', () => sockets.delete(s));
      s.on('error', () => {
        client.destroy();
        upstream.destroy();
      });
    }
    client.pipe(upstream).pipe(client);
  });
  // A client refusing the certificate aborts the handshake; not a test failure.
  server.on('tlsClientError', () => {});
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as net.AddressInfo;
  return {
    port,
    close: () =>
      new Promise<void>((resolve) => {
        for (const s of sockets) s.destroy();
        server.close(() => resolve());
      }),
  };
}

/** A localhost port with nothing listening on it. */
export async function closedPort(): Promise<number> {
  const server = net.createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as net.AddressInfo;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

/**
 * The broker's names of the AMQP connections Checkouts of `queue` hold open
 * (named "volveran checkout <vhost> <queue>"), for closing them in tests.
 * The management API lists a new connection within a second or so.
 */
export async function checkoutConnectionNames(queue: string, vhost = '/'): Promise<string[]> {
  const res = await management('/connections?columns=name,user_provided_name');
  const list = res.body as Array<{ name: string; user_provided_name?: string }>;
  return list.filter((c) => c.user_provided_name === `volveran checkout ${vhost} ${queue}`).map((c) => c.name);
}

/**
 * Polls Checkout `id` as its owner (through `owner`) until its Apply has
 * ended, and returns the Checkout view: Apply runs in the background, and
 * its outcomes land on the Checkout (`lastApply`).
 */
/** What appliedCheckout and applyAndWait need of a client: a TestApp, or a signed-in TestBrowser. */
export interface ApiClient {
  get(urlPath: string): Promise<TestResponse>;
  post(urlPath: string, body?: unknown): Promise<TestResponse>;
}

export async function appliedCheckout(owner: ApiClient, id: string, timeoutMs = 15_000): Promise<any> {
  return eventually(async () => {
    const { checkout } = (await owner.get(`/api/checkouts/${id}`)).body;
    // A Checkout lost mid-Apply is no longer `applying`, but its step in progress may not have settled yet.
    if (checkout.status === 'applying' || (checkout.applyProgress && !checkout.lastApply)) {
      throw new Error(`Checkout ${id} is still applying`);
    }
    return checkout;
  }, timeoutMs, 50);
}

/**
 * POSTs `body` to `urlPath` (an Apply or an approve) through `on`. On 202 it
 * waits for the Apply to end and answers 202 with the Checkout view as its
 * owner sees it then (through `owner`, default `on`) and its outcomes,
 * where v0.3's Apply response had them; any other answer is returned as is.
 */
export async function applyAndWait(on: ApiClient, urlPath: string, body: unknown, owner: ApiClient = on): Promise<TestResponse> {
  const res = await on.post(urlPath, body);
  if (res.status !== 202) return res;
  const checkout = await appliedCheckout(owner, res.body.checkout.id);
  return { status: 202, body: { checkout, outcomes: checkout.lastApply?.outcomes } };
}
