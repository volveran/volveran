// Integration test harness: starts Volverán in-process against this
// checkout's test broker and drives its HTTP API.
//
// The broker helpers (withChannel, seedMessages, management, ...) live in
// test/broker/client.ts, shared with the broker-facts suite, and are
// re-exported here so test files import everything from one place.
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import tls from 'node:tls';
import { stringify } from 'yaml';
import { repoRoot } from '../../scripts/test-broker-env.mjs';
import type { CheckoutTestHooks } from '../../src/server/checkout/manager.js';
import { startServer } from '../../src/server/server.js';
import type { CheckoutLimits } from '../../src/server/triage/checkout-collection.js';
import type { CheckoutTiming } from '../../src/server/triage/checkout-timing.js';
import { brokerUsers, management, testBroker } from '../broker/client.js';

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
