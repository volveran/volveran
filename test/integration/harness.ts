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
import type { SamplerControl, SamplerTestHooks, SamplingRun } from '../../src/server/history/sampler.js';
import type { CheckoutTestHooks } from '../../src/server/checkout/manager.js';
import type { RuleClock, RuleSchedulerControl } from '../../src/server/replay-rules/rule-clock.js';
import type { RulePass, RulePassSummary } from '../../src/shared/replay-rules.js';
import { startServer, type ServerOptions } from '../../src/server/server.js';
import type { CheckoutLimits } from '../../src/server/triage/checkout-collection.js';
import type { CheckoutTiming } from '../../src/server/triage/checkout-timing.js';
import { brokerUsers, eventually, management, testBroker } from '../broker/client.js';
import { storeEnv } from './test-store.js';

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
  /** Alert Rules, as written in the profiles file. */
  alerts?: Array<Record<string, unknown>>;
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
  /** Where the metrics are scraped, when VOLVERAN_METRICS_PORT is set. */
  metricsUrl?: string;
  get<T = any>(urlPath: string): Promise<TestResponse<T>>;
  post<T = any>(urlPath: string, body?: unknown): Promise<TestResponse<T>>;
  delete<T = any>(urlPath: string): Promise<TestResponse<T>>;
  close(): Promise<void>;
}

export interface StartAppOptions {
  profiles?: ProfileFixture[];
  /** The top-level `alertDestinations`, as written in the profiles file. */
  alertDestinations?: Array<Record<string, unknown>>;
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
  /** Wraps the audit store the app's callers talk to (delayedAuditStore in test/support/). */
  wrapAuditStore?: ServerOptions['wrapAuditStore'];
  /** The queue sampler's clock and "sample now" (samplerHooks). */
  samplerTestHooks?: SamplerTestHooks;
  /** The audit store's directory (kept by the caller); default in memory. */
  dataDir?: string;
  /** Overrides the body retention limits and interval (ms) from the environment. */
  bodyRetention?: Partial<BodyRetention>;
  /** Collects the app's log lines (parsed JSON) here; default no logging. */
  logs?: Array<Record<string, any>>;
  /** The directory of the built web app; default API only. */
  webRoot?: string;
  /** Told of each route the app registers. */
  onRouteRegistered?: ServerOptions['onRouteRegistered'];
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
  await writeFile(profilesFile, options.rawYaml ?? stringify({ profiles, ...(options.alertDestinations && { alertDestinations: options.alertDestinations }) }));

  const env: Record<string, string | undefined> = { VOLVERAN_OPERATOR: testOperator };
  for (const p of profiles) {
    if (p.passwordEnv === passwordEnvFor(p.name)) env[p.passwordEnv] = brokerUsers.admin.password;
  }
  Object.assign(env, options.env);
  // A test that names its store keeps it; any other runs on the store under test.
  const store = options.env && 'VOLVERAN_POSTGRES_URL' in options.env ? null : await storeEnv(options.dataDir);
  Object.assign(env, store?.env);

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
      wrapAuditStore: options.wrapAuditStore,
      samplerTestHooks: options.samplerTestHooks,
      dataDir: options.dataDir,
      bodyRetention: options.bodyRetention,
      webRoot: options.webRoot,
      onRouteRegistered: options.onRouteRegistered,
      logger: options.logs && { stream: { write: (line: string) => void options.logs!.push(JSON.parse(line)) } },
    });
  } catch (err) {
    await store?.release();
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
    metricsUrl: server.metricsUrl,
    get: (urlPath) => request('GET', urlPath),
    post: (urlPath, body) => request('POST', urlPath, body ?? {}),
    delete: (urlPath) => request('DELETE', urlPath),
    async close() {
      await server.close();
      await store?.release();
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
  const dataDir = options.dataDir ?? path.join(options.dir, 'data');
  const store = 'VOLVERAN_POSTGRES_URL' in options.env ? null : await storeEnv(dataDir);
  const child = spawn(process.execPath, ['--import', 'tsx', options.script], {
    cwd: repoRoot,
    env: {
      PATH: process.env.PATH,
      VOLVERAN_PROFILES_FILE: profilesFile,
      VOLVERAN_PORT: '0',
      VOLVERAN_DATA_DIR: dataDir,
      ...store?.env,
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
/**
 * The management port behind a proxy: closing it is the broker stopping, as far
 * as Volverán can tell, and opening it again, on the same port, is the broker
 * coming back, without touching the broker the other tests share.
 */
export async function closableManagementProxy(): Promise<{ url: string; close(): Promise<void>; open(): Promise<void> }> {
  const sockets = new Set<net.Socket>();
  let port = 0;
  let server: net.Server;
  const open = async () => {
    server = net.createServer((client) => {
      const upstream = net.connect(Number(new URL(testBroker.managementUrl).port), '127.0.0.1');
      for (const socket of [client, upstream]) {
        sockets.add(socket);
        socket.on('close', () => sockets.delete(socket));
        socket.on('error', () => {
          client.destroy();
          upstream.destroy();
        });
      }
      client.pipe(upstream).pipe(client);
    });
    await new Promise<void>((resolve) => server.listen(port, '127.0.0.1', resolve));
    port = (server.address() as net.AddressInfo).port;
  };
  await open();
  return {
    url: `http://127.0.0.1:${port}`,
    open,
    close: () =>
      new Promise<void>((resolve) => {
        for (const socket of sockets) socket.destroy();
        server.close(() => resolve());
      }),
  };
}

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

/**
 * A test clock for the Replay rule scheduler, and its "run a pass now", as
 * Checkout test hooks (`hooks`, for startApp's checkoutTestHooks). The clock
 * starts at `start` and moves only when told: `advance` moves it and fires
 * the timers due by then. `runPass` runs the scheduled pass of a rule at
 * once, as its timer would, in the app started last with these hooks; it
 * resolves with the pass, or null when the scheduler would not run it.
 */
export function ruleSchedulerHooks(start = new Date()) {
  let now = start.getTime();
  let timers: Array<{ at: number; run: () => void }> = [];
  let control: RuleSchedulerControl | undefined;
  const clock: RuleClock = {
    now: () => new Date(now),
    setTimer(run, ms) {
      const timer = { at: now + ms, run };
      timers.push(timer);
      return { cancel: () => void (timers = timers.filter((t) => t !== timer)) };
    },
  };
  const hooks: CheckoutTestHooks = { ruleScheduler: { clock, scheduler: (c) => (control = c) } };
  return {
    hooks,
    now: () => new Date(now),
    set(at: Date) {
      now = at.getTime();
    },
    advance(ms: number) {
      now += ms;
      const due = timers.filter((t) => t.at <= now);
      timers = timers.filter((t) => t.at > now);
      for (const t of due) t.run();
    },
    runPass(profile: string, rule: string): Promise<RulePass | null> {
      if (!control) throw new Error('No app has started with these hooks');
      return control.runScheduledPass(profile, rule);
    },
  };
}

/** What a Rule Pass counted; when it did not run, fails saying what it was instead, with its reason. */
export function ranSummary(pass: RulePass | null): RulePassSummary {
  if (!pass) throw new Error('Expected a Rule Pass, but none ran: the rule is paused or a pass of it is running');
  if (pass.status !== 'ran') throw new Error(`Expected a Rule Pass to run, but it was ${pass.status}: ${pass.reason}`);
  return pass.summary!;
}

/**
 * A test clock for the queue sampler, and its "sample now" (`hooks`, for
 * startApp's samplerTestHooks). The clock starts at `start` and moves only when
 * told: `advance` moves it and fires the timers due by then. `sampleNow` runs
 * every sampled profile at once, in the app started last with these hooks, and
 * resolves when each run is recorded. Set the clock to the wall clock before a
 * run that should see Audit Entries, which carry real time.
 */
export function samplerHooks(start = new Date()) {
  let now = start.getTime();
  let timers: Array<{ at: number; run: () => void }> = [];
  let control: SamplerControl | undefined;
  const clock: RuleClock = {
    now: () => new Date(now),
    setTimer(run, ms) {
      const timer = { at: now + ms, run };
      timers.push(timer);
      return { cancel: () => void (timers = timers.filter((t) => t !== timer)) };
    },
  };
  const started = (): SamplerControl => {
    if (!control) throw new Error('No app has started with these hooks');
    return control;
  };
  const hooks: SamplerTestHooks = { clock, sampler: (c) => (control = c) };
  return {
    hooks,
    now: () => new Date(now),
    set(at: Date) {
      now = at.getTime();
    },
    advance(ms: number) {
      now += ms;
      const due = timers.filter((t) => t.at <= now);
      timers = timers.filter((t) => t.at > now);
      for (const t of due) t.run();
    },
    sampleNow: (): Promise<SamplingRun[]> => started().sampleNow(),
    latest: () => started().latest(),
    onRun: (listener: Parameters<SamplerControl['onRun']>[0]) => started().onRun(listener),
  };
}
