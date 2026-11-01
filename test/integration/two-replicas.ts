// Two in-process Replicas in Team Mode against this checkout's test broker and one
// PostgreSQL, built on startApp. A test asks either one, or a random one, and asserts
// the Operator sees no difference. CONTRIBUTING.md ("Two Replicas") has the interface.
//
// Everything a Replica reaches or is reached by goes through a TCP proxy of its own:
// its HTTP port, the broker's AMQP and management ports, and PostgreSQL. So `crash` needs
// no seam in the app. It closes them all at once, which the outside world sees as a killed
// process: connections drop with nothing settled and nothing written. Only then is
// what is left of the app told to close, without waiting for it.
import { startApp, type ProfileFixture, type StartAppOptions, type TestApp, type TestResponse } from './harness.js';
import { teamModeEnv, TestBrowser } from './oidc-provider.js';
import { startTcpProxy, type TcpProxy } from '../support/tcp-proxy.js';
import { createTestDatabase, type TestDatabase } from '../support/test-postgres.js';

export type ReplicaName = 'a' | 'b';

export interface Replica {
  readonly name: ReplicaName;
  /** Where it is reached now; a restart changes it. */
  readonly baseUrl: string;
  /** Whether it is up: after a `crash` or `shutdown`, false until `restart`. */
  readonly running: boolean;
  /** Without a session: a route for anyone, such as /readyz. For an Operator, use `browser().to(replica)`. */
  get<T = any>(urlPath: string): Promise<TestResponse<T>>;
  post<T = any>(urlPath: string, body?: unknown): Promise<TestResponse<T>>;
  /** Stops it abruptly, as a killed process: nothing ends cleanly and nothing more is written. */
  crash(): Promise<void>;
  /** Stops it gracefully, as on SIGTERM. */
  shutdown(): Promise<void>;
  /** Starts it again, on the same store. It must be stopped. */
  restart(): Promise<void>;
}

/** An Operator's browser. Each request goes to a random running Replica; `to` chooses one. Cookies are shared, as they are per host. */
export class ReplicaBrowser extends TestBrowser {
  constructor(
    pick: () => Replica,
    private readonly publicOrigin: string,
    cookies?: Map<string, string>,
  ) {
    super(() => pick().baseUrl, cookies);
  }

  /** The same browser, cookies included, with its requests going to `replica`. */
  to(replica: Replica): ReplicaBrowser {
    return new ReplicaBrowser(() => replica, this.publicOrigin, this.cookies);
  }

  /** A URL at the public address (the provider's redirect back) reaches a Replica, as through a load balancer. */
  override request(method: string, url: string, init?: Parameters<TestBrowser['request']>[2]) {
    return super.request(method, url.startsWith(`${this.publicOrigin}/`) ? url.slice(this.publicOrigin.length) : url, init);
  }
}

export interface TwoReplicasOptions extends Pick<StartAppOptions, 'profiles' | 'alertDestinations' | 'env' | 'checkoutLimits' | 'checkoutTiming' | 'endedCheckoutRetentionMs' | 'bodyRetention'> {
  /** What differs per Replica, such as test hooks, a wrapped store or `logs`. Called again on a restart. */
  perReplica?: (name: ReplicaName) => Pick<StartAppOptions, 'checkoutTestHooks' | 'samplerTestHooks' | 'wrapAuditStore' | 'logs' | 'env'>;
}

export interface TwoReplicas {
  a: Replica;
  b: Replica;
  /** A random running Replica. */
  random(): Replica;
  /** The other one. */
  other(replica: Replica): Replica;
  /** A new browser with no session, for one Operator. */
  browser(): ReplicaBrowser;
  /** The one database they share, to read what no route shows. */
  database: TestDatabase;
  /** Stops whatever still runs and drops the database. */
  close(): Promise<void>;
}

/** A local proxy to `url`'s port, and `url` pointing at it. */
async function proxied(url: string, proxies: TcpProxy[]): Promise<string> {
  const target = new URL(url);
  const proxy = await startTcpProxy(Number(target.port));
  proxies.push(proxy);
  target.hostname = '127.0.0.1';
  target.port = String(proxy.port);
  // URL keeps a path of "/" that an AMQP or management URL may not have had.
  return url.endsWith('/') ? target.href : target.href.replace(/\/$/, '');
}

async function proxiedProfile(profile: ProfileFixture, proxies: TcpProxy[]): Promise<ProfileFixture> {
  return {
    ...profile,
    ...(profile.amqpUrl && { amqpUrl: await proxied(profile.amqpUrl, proxies) }),
    ...(profile.managementUrl && { managementUrl: await proxied(profile.managementUrl, proxies) }),
  };
}

export async function startTwoReplicas(options: TwoReplicasOptions = {}): Promise<TwoReplicas> {
  const database = await createTestDatabase();
  // No one listens here: the provider's redirect is sent to a Replica by ReplicaBrowser.
  const publicOrigin = 'http://127.0.0.1:9';

  const startReplica = (name: ReplicaName): Promise<Replica> => {
    let running: { app: TestApp; proxies: TcpProxy[]; baseUrl: string } | null = null;

    const up = async (): Promise<void> => {
      const proxies: TcpProxy[] = [];
      const { perReplica, profiles, env, ...shared } = options;
      const own = perReplica?.(name) ?? {};
      const app = await startApp({
        ...shared,
        ...own,
        profiles: await Promise.all((profiles ?? []).map((profile) => proxiedProfile(profile, proxies))),
        env: {
          ...teamModeEnv(publicOrigin),
          VOLVERAN_POSTGRES_URL: await proxied(database.url, proxies),
          ...env,
          ...own.env,
        },
      });
      const http = await proxied(app.baseUrl, proxies);
      running = { app, proxies, baseUrl: http };
    };

    const stopped = (): never => {
      throw new Error(`Replica ${name} is not running`);
    };
    const release = async (proxies: TcpProxy[]) => {
      await Promise.all(proxies.map((proxy) => proxy.close()));
    };
    const send = async (method: string, urlPath: string, body?: unknown): Promise<TestResponse> => {
      const res = await fetch((running ?? stopped()).baseUrl + urlPath, {
        method,
        headers: body === undefined ? {} : { 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const text = await res.text();
      let parsed: unknown = text;
      try {
        parsed = text ? JSON.parse(text) : undefined;
      } catch {
        // not JSON, as /metrics is not
      }
      return { status: res.status, body: parsed };
    };

    const replica: Replica = {
      name,
      get baseUrl() {
        return (running ?? stopped()).baseUrl;
      },
      get running() {
        return running !== null;
      },
      get: (urlPath) => send('GET', urlPath),
      post: (urlPath, body) => send('POST', urlPath, body ?? {}),
      async crash() {
        const { app, proxies } = running ?? stopped();
        running = null;
        // Closing a proxy drops its connections and refuses new ones, all before anything else runs.
        await release(proxies);
        // Not awaited: a killed process does not wait for its own clean-up, and with a live Checkout this one may never finish.
        void app.close().catch(() => {});
      },
      async shutdown() {
        const { app, proxies } = running ?? stopped();
        running = null;
        await app.close();
        await release(proxies);
      },
      async restart() {
        if (running) throw new Error(`Replica ${name} is running`);
        await up();
      },
    };
    return up().then(() => replica);
  };

  // One after the other: both migrating at once is tested elsewhere, and a failure stays readable.
  const a = await startReplica('a');
  const b = await startReplica('b');

  const random = (): Replica => {
    const up = [a, b].filter((replica) => replica.running);
    const replica = up[Math.floor(Math.random() * up.length)];
    if (!replica) throw new Error('No Replica is running');
    return replica;
  };

  return {
    a,
    b,
    random,
    other: (replica) => (replica === a ? b : a),
    browser: () => new ReplicaBrowser(random, publicOrigin),
    database,
    async close() {
      await Promise.all([a, b].filter((replica) => replica.running).map((replica) => replica.shutdown()));
      await database.drop();
    },
  };
}
