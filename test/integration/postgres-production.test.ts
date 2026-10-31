// PostgreSQL as production runs it: over TLS, refusing clearly what it cannot start on, and
// behaving when the database misbehaves. An Apply stops without settling a Message that has
// no Audit Entry (ADR 0001), /readyz says so, and Volverán comes back by itself.
import { spawn } from 'node:child_process';
import { readdir, readFile, rm, writeFile } from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { stringify } from 'yaml';
import { repoRoot } from '../../scripts/test-broker-env.mjs';
import { createPool, transaction } from '../../src/server/audit/postgres-connection.js';
import { PostgresAuditStore } from '../../src/server/audit/postgres-audit-store.js';
import { ConfigError } from '../../src/server/config-error.js';
import { createTestDatabase, type TestDatabase } from '../support/test-postgres.js';
import { startTcpProxy, type TcpProxy } from '../support/tcp-proxy.js';
import { closedPort, eventually, fixtureQueues, makeTempDir, purgeQueues, readyMessageIds, seedMessages, startApp, testProfile, tlsFixtures, uniqueName, type TestApp } from './harness.js';
import { storeUnderTest } from './test-store.js';
import { teamModeEnv } from './oidc-provider.js';

const QUEUE = 'orders.dlq';
const DISCARD = { kind: 'discard', reason: 'bad payload' };
const profiles = () => [testProfile({ name: 'local' })];

const withPort = (url: string, port: number) => {
  const u = new URL(url);
  u.port = String(port);
  return u.href;
};
const portOf = (url: string) => Number(new URL(url).port);

describe('TLS to PostgreSQL', () => {
  let database: TestDatabase;
  let ca: string;
  beforeAll(async () => {
    database = await createTestDatabase();
    ca = await readFile(tlsFixtures.caFile, 'utf8');
  });
  afterAll(async () => {
    await database.drop();
  });

  it('connects over TLS with the CA file, verifying the certificate', async () => {
    const pool = createPool(database.url, { tls: { ca } });
    try {
      const { rows } = await pool.query('SELECT ssl FROM pg_stat_ssl WHERE pid = pg_backend_pid()');
      expect(rows).toEqual([{ ssl: true }]);
    } finally {
      await pool.end();
    }
  });

  it('starts an app with required TLS and the CA file named by the environment', async () => {
    const app = await startApp({
      profiles: profiles(),
      env: { VOLVERAN_POSTGRES_URL: database.url, VOLVERAN_POSTGRES_REQUIRE_TLS: 'true', VOLVERAN_POSTGRES_CA_FILE: tlsFixtures.caFile },
    });
    expect((await app.get('/readyz')).status).toBe(200);
    await app.close();
  });

  it('refuses a certificate it cannot verify, saying it is about TLS', async () => {
    const refused = PostgresAuditStore.open(database.url, {});
    await expect(refused).rejects.toBeInstanceOf(ConfigError);
    await expect(refused).rejects.toThrow(/TLS.*VOLVERAN_POSTGRES_CA_FILE/s);
  });

  it('refuses a certificate that does not name the host it connected to', async () => {
    // The CA signed the certificate, which names 127.0.0.1 and localhost, and this is 127.0.0.2.
    const proxy = await startTcpProxy(portOf(database.url), '127.0.0.2');
    const u = new URL(database.url);
    u.hostname = '127.0.0.2';
    u.port = String(proxy.port);
    try {
      const refused = PostgresAuditStore.open(u.href, { ca });
      await expect(refused).rejects.toBeInstanceOf(ConfigError);
      await expect(refused).rejects.toThrow(/TLS/);
    } finally {
      await proxy.close();
    }
  });

  it('refuses a server that offers no TLS when it is required', async () => {
    // Answers "no" to the request to start TLS, as a PostgreSQL with ssl=off does.
    const plain = net.createServer((socket) => {
      socket.on('error', () => {});
      socket.once('data', () => socket.write('N'));
    });
    await new Promise<void>((resolve) => plain.listen(0, '127.0.0.1', resolve));
    const { port } = plain.address() as net.AddressInfo;
    try {
      const refused = PostgresAuditStore.open(withPort(database.url, port), {});
      await expect(refused).rejects.toBeInstanceOf(ConfigError);
      await expect(refused).rejects.toThrow(/TLS/);
    } finally {
      await new Promise((resolve) => plain.close(resolve));
    }
  });

  it('refuses a CA file that cannot be read', async () => {
    const refused = startApp({
      profiles: profiles(),
      env: { VOLVERAN_POSTGRES_URL: database.url, VOLVERAN_POSTGRES_CA_FILE: '/nonexistent/ca.crt' },
    });
    await expect(refused).rejects.toBeInstanceOf(ConfigError);
    await expect(refused).rejects.toThrow(/VOLVERAN_POSTGRES_CA_FILE/);
  });
});

describe('refusing to start on PostgreSQL', () => {
  let database: TestDatabase;
  beforeEach(async () => {
    database = await createTestDatabase();
  });
  afterEach(async () => {
    await database.drop();
  });

  const refusal = async (url: string): Promise<ConfigError> => {
    const err = await PostgresAuditStore.open(url).then(
      () => {
        throw new Error('expected it to refuse');
      },
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(ConfigError);
    expect((err as Error).message).not.toContain('volveran-test-pass');
    return err as ConfigError;
  };
  /**
   * Closing a pool answers before its backends have left pg_stat_activity (up to about
   * 200 ms on a database short of CPU), so this waits for them, and fails on one that stays.
   */
  const connectionsClosed = () =>
    eventually(async () => {
      const dbName = new URL(database.url).pathname.slice(1);
      const { rows } = await database.query('SELECT COUNT(*) AS others FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()', [dbName]);
      expect(rows[0].others).toBe('0');
    }, 5_000, 50);
  const withUser = (url: string, user: string, password: string) => {
    const u = new URL(url);
    u.username = user;
    u.password = password;
    return u.href;
  };

  it('says it cannot reach an unreachable database', async () => {
    const port = await closedPort();
    const err = await refusal(withPort(database.url, port));
    expect(err.message).toContain(`Could not reach PostgreSQL at 127.0.0.1:${port}`);
  });

  it('says a password was refused', async () => {
    const err = await refusal(withUser(database.url, 'volveran', 'wrong-password'));
    expect(err.message).toMatch(/refused the user "volveran"/);
    expect(err.message).not.toContain('wrong-password');
  });

  it('says a database does not exist, and that it never creates one', async () => {
    const u = new URL(database.url);
    u.pathname = '/no_such_database';
    expect((await refusal(u.href)).message).toMatch(/no database "no_such_database".*never creates/s);
  });

  it('says what permission the user lacks', async () => {
    const role = `limited_${uniqueName('r').replace(/\W/g, '_')}`;
    await database.query(`CREATE ROLE ${role} LOGIN PASSWORD 'limited-pass'`);
    try {
      const err = await refusal(withUser(database.url, role, 'limited-pass'));
      expect(err.message).toMatch(new RegExp(`user "${role}" lacks a permission.*create tables`, 's'));
    } finally {
      await database.query(`DROP OWNED BY ${role}`);
      await database.query(`DROP ROLE ${role}`);
    }
  });

  it('refuses a database that is not UTF8, before creating anything in it', async () => {
    const name = `latin_${uniqueName('d').replace(/\W/g, '_')}`;
    await database.query(`CREATE DATABASE ${name} ENCODING 'LATIN1' LOCALE 'C' TEMPLATE template0`);
    const u = new URL(database.url);
    u.pathname = `/${name}`;
    try {
      expect((await refusal(u.href)).message).toMatch(new RegExp(`"${name}" is encoded in LATIN1.*UTF8`, 's'));
      const pool = createPool(u.href);
      const { rows } = await pool.query(`SELECT COUNT(*) AS tables FROM pg_tables WHERE schemaname = 'public'`);
      await pool.end();
      expect(rows).toEqual([{ tables: 0 }]);
    } finally {
      await database.query(`DROP DATABASE ${name} WITH (FORCE)`);
    }
  });

  it('closes its connections when startup fails after the store opened', async () => {
    // Team Mode with an OIDC provider that is not there: the store is open by then.
    const baseUrl = `http://127.0.0.1:${await closedPort()}`;
    const dead = `http://127.0.0.1:${await closedPort()}/default`;
    const refused = startApp({
      profiles: profiles(),
      env: { ...teamModeEnv(baseUrl), VOLVERAN_OIDC_ISSUER: dead, VOLVERAN_POSTGRES_URL: database.url },
    });
    await expect(refused).rejects.toBeDefined();
    await connectionsClosed();
  });

  it('closes its connections when the port is taken', async () => {
    const taken = net.createServer();
    await new Promise<void>((resolve) => taken.listen(0, '127.0.0.1', resolve));
    const { port } = taken.address() as net.AddressInfo;
    await expect(startApp({ profiles: profiles(), port, env: { VOLVERAN_POSTGRES_URL: database.url } })).rejects.toBeDefined();
    await new Promise((resolve) => taken.close(resolve));
    await connectionsClosed();
  });

  it('prints one clear line and no stack trace from the process itself', async () => {
    const dir = await makeTempDir('postgres-start');
    try {
      const profilesFile = path.join(dir, 'profiles.yaml');
      await writeFile(profilesFile, stringify({ profiles: profiles() }));
      const port = await closedPort();
      const child = spawn(process.execPath, ['--import', 'tsx', 'src/server/main.ts'], {
        cwd: repoRoot,
        env: {
          PATH: process.env.PATH,
          VOLVERAN_PROFILES_FILE: profilesFile,
          VOLVERAN_PORT: '0',
          VOLVERAN_OPERATOR: 'me',
          VOLVERAN_POSTGRES_URL: withPort(database.url, port),
        },
      });
      let stderr = '';
      child.stderr.on('data', (chunk) => (stderr += chunk));
      const status = await new Promise((resolve) => child.on('close', resolve));
      expect(status).toBe(1);
      expect(stderr).toContain(`Could not reach PostgreSQL at 127.0.0.1:${port}`);
      expect(stderr).not.toMatch(/^\s+at /m);
      expect(stderr).not.toContain('volveran-test-pass');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('when PostgreSQL goes away', () => {
  let database: TestDatabase;
  let proxy: TcpProxy;
  let app: TestApp;
  let beforeApplyStep: ((entryId: number) => Promise<void>) | null = null;
  const logs: Array<Record<string, any>> = [];

  beforeEach(async () => {
    database = await createTestDatabase();
    proxy = await startTcpProxy(portOf(database.url));
    await purgeQueues('/', fixtureQueues);
    logs.length = 0;
    app = await startApp({
      profiles: profiles(),
      logs,
      env: { VOLVERAN_POSTGRES_URL: withPort(database.url, proxy.port) },
      checkoutTestHooks: { beforeApplyStep: async (entryId) => beforeApplyStep?.(entryId) },
    });
  });
  afterEach(async () => {
    beforeApplyStep = null;
    proxy.restore();
    await app.close();
    await proxy.close();
    await database.drop();
    await purgeQueues('/', fixtureQueues);
  });

  async function checkoutOfAll(seeded: number) {
    await seedMessages('/', QUEUE, seeded);
    const started = await app.post(`/api/profiles/local/vhosts/%2F/queues/${QUEUE}/checkouts`);
    expect(started.status).toBe(201);
    const { id, messages } = started.body.checkout;
    expect((await app.post(`/api/checkouts/${id}/decisions`, { handles: messages.map((m: any) => m.handle), decision: DISCARD })).status).toBe(200);
    return id as string;
  }
  const appliedOutcomes = async (id: string) =>
    eventually(
      async () => {
        const { body } = await app.get(`/api/checkouts/${id}`);
        expect(body.checkout.status).toBe('ended');
        return body.checkout.lastApply.outcomes as Array<{ messageId: string; status: string; reason: string | null }>;
      },
      25_000,
    );

  it('stops an Apply at once, settling no Message without its Audit Entry', async () => {
    const id = await checkoutOfAll(3);
    proxy.cut();

    expect((await app.post(`/api/checkouts/${id}/apply`, { confirm: true })).status).toBe(202);
    const outcomes = await appliedOutcomes(id);

    expect(outcomes.map((o) => o.status)).toEqual(['failed', 'not-attempted', 'not-attempted']);
    expect(outcomes[0]!.reason).toMatch(/Could not write the Audit Entry/);
    expect(outcomes[1]!.reason).toMatch(/audit store.*back in the queue/);
    expect((await readyMessageIds('/', QUEUE)).sort()).toEqual([`${QUEUE}-0`, `${QUEUE}-1`, `${QUEUE}-2`]);
    proxy.restore();
    await eventually(async () => expect((await app.get(`/api/audit-entries?checkoutId=${id}`)).body.entries).toEqual([]));
  });

  it('stops after the step in progress when the database goes during it', async () => {
    const id = await checkoutOfAll(3);
    beforeApplyStep = async () => proxy.cut();

    expect((await app.post(`/api/checkouts/${id}/apply`, { confirm: true })).status).toBe(202);
    const outcomes = await appliedOutcomes(id);

    // The first has its pending entry committed, so it may be settled. The rest never start.
    expect(outcomes.map((o) => o.status)).toEqual(['done', 'not-attempted', 'not-attempted']);
    expect((await readyMessageIds('/', QUEUE)).sort()).toEqual([`${QUEUE}-1`, `${QUEUE}-2`]);
    proxy.restore();
    const entries = await eventually(async () => {
      const res = await app.get(`/api/audit-entries?checkoutId=${id}`);
      expect(res.status).toBe(200);
      return res.body.entries;
    });
    expect(entries).toEqual([expect.objectContaining({ messageId: `${QUEUE}-0`, outcome: 'pending' })]);
  });

  it('fails /readyz, keeps /healthz fixed, and recovers by itself', async () => {
    expect((await app.get('/readyz')).status).toBe(200);
    proxy.cut();

    const notReady = await app.get('/readyz');
    expect(notReady.status).toBe(503);
    expect(notReady.body).toEqual({ status: 'unavailable' });
    const healthy = await app.get('/healthz');
    expect(healthy).toEqual({ status: 200, body: { status: 'ok' } });
    expect(logs.filter((l) => /audit store is unreachable/.test(l.msg))).toHaveLength(1);
    await app.get('/readyz');
    expect(logs.filter((l) => /audit store is unreachable/.test(l.msg))).toHaveLength(1);

    proxy.restore();
    await eventually(async () => expect((await app.get('/readyz')).status).toBe(200));
    expect(logs.filter((l) => /audit store is reachable again/.test(l.msg))).toHaveLength(1);
  });

  it('answers /readyz in time when the database has vanished without a word', async () => {
    proxy.silence();
    const asked = Date.now();
    expect((await app.get('/readyz')).status).toBe(503);
    expect(Date.now() - asked).toBeLessThan(3_000); // the chart's probe timeout
  });

  it('records Audit Entries again without a restart once the database returns', async () => {
    proxy.cut();
    await new Promise((resolve) => setTimeout(resolve, 200));
    proxy.restore();

    const id = await checkoutOfAll(1);
    expect((await app.post(`/api/checkouts/${id}/apply`, { confirm: true })).status).toBe(202);
    expect((await appliedOutcomes(id)).map((o) => o.status)).toEqual(['done']);
    expect((await app.get(`/api/audit-entries?checkoutId=${id}`)).body.entries).toEqual([expect.objectContaining({ outcome: 'done' })]);
  });

  it('never depends on a broker for /readyz', async () => {
    await app.close();
    const dead = await closedPort();
    app = await startApp({
      profiles: [testProfile({ name: 'local', managementUrl: `http://127.0.0.1:${dead}`, amqpUrl: `amqp://127.0.0.1:${dead}` })],
      env: { VOLVERAN_POSTGRES_URL: withPort(database.url, proxy.port) },
    });
    expect((await app.get('/readyz')).status).toBe(200);
  });
});

describe('a connection lost in the middle of a transaction', () => {
  it('rejects the call instead of stopping the process', async () => {
    const database = await createTestDatabase();
    const proxy = await startTcpProxy(portOf(database.url));
    const seen: unknown[] = [];
    const onUncaught = (err: unknown) => seen.push(err);
    process.on('uncaughtException', onUncaught);
    try {
      const pool = createPool(withPort(database.url, proxy.port));
      await expect(
        transaction(pool, async (client) => {
          await client.query('SELECT 1');
          proxy.cut();
          await new Promise((resolve) => setTimeout(resolve, 100));
          await client.query('SELECT 1');
        }),
      ).rejects.toBeDefined();
      await pool.end();
      expect(seen).toEqual([]);
    } finally {
      process.off('uncaughtException', onUncaught);
      await proxy.close();
      await database.drop();
    }
  });
});

describe.runIf(storeUnderTest() === 'postgres')('the suite on PostgreSQL', () => {
  it('keeps nothing in the data directory, so the suite does run on PostgreSQL', async () => {
    const dataDir = await makeTempDir('on-postgres');
    const app = await startApp({ profiles: profiles(), dataDir });
    await app.close();
    expect(await readdir(dataDir)).toEqual([]);
    await rm(dataDir, { recursive: true, force: true });
  });
});
