// Sessions with several Replicas (#92): an Operator signs in, stays signed in and signs
// out whichever Replica each request reaches. On SQLite they stay in memory.
import { rm } from 'node:fs/promises';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { keySeal } from '../../src/server/token-seal.js';
import { closedPort, eventually, makeTempDir, purgeQueues, readyCount, seedMessages, startApp, testProfile, withChannel } from './harness.js';
import { teamModeEnv, testSessionEncryptionKey, testSessionSecret, TestBrowser, type TestIdentity } from './oidc-provider.js';
import { startTwoReplicas, type TwoReplicas } from './two-replicas.js';

const alice: TestIdentity = { sub: 'alice-sub', email: 'alice@example.com', name: 'Alice Doe', groups: ['ops'] };
const operatorOf = { operatorId: 'alice-sub', email: 'alice@example.com', name: 'Alice Doe', groups: ['ops'] };

describe('sessions shared by two Replicas', () => {
  let replicas: TwoReplicas;
  beforeAll(async () => {
    replicas = await startTwoReplicas({ profiles: [testProfile({ name: 'dev' })] });
  });
  afterAll(async () => {
    await replicas?.close();
  });
  afterEach(async () => {
    for (const replica of [replicas.a, replicas.b]) if (!replica.running) await replica.restart();
  });

  it.each(['a', 'b'] as const)('finishes a sign-in started on Replica %s when the callback reaches the other', async (name) => {
    const first = replicas[name];
    const browser = replicas.browser();
    const authorizeUrl = await browser.to(first).startSignIn();
    const callback = await browser.approveAtProvider(authorizeUrl, alice);
    const back = await browser.to(replicas.other(first)).get(callback);
    expect(back.status).toBe(302);
    expect((await browser.to(first).get('/api/session')).body).toMatchObject(operatorOf);
    expect((await browser.to(replicas.other(first)).get('/api/session')).body).toMatchObject(operatorOf);
  });

  it('serves the Operator through whichever Replica a request reaches', async () => {
    const browser = replicas.browser();
    await browser.signIn(alice);
    for (let i = 0; i < 10; i++) {
      const session = await browser.get('/api/session');
      expect(session.status).toBe(200);
      expect(session.body).toMatchObject(operatorOf);
    }
  });

  it('hands a sign-in to one callback only, across Replicas', async () => {
    const browser = replicas.browser();
    const callback = await browser.approveAtProvider(await browser.to(replicas.a).startSignIn(), alice);
    const cookies = new Map(browser.cookies);
    expect((await browser.to(replicas.a).get(callback)).status).toBe(302);
    browser.cookies.clear();
    for (const [k, v] of cookies) browser.cookies.set(k, v);
    const again = await browser.to(replicas.b).get(callback);
    expect(again.status).toBe(400);
    expect(again.body.error.code).toBe('sign_in_failed');
  });

  it('keeps the Operator signed in when each Replica restarts in turn', async () => {
    const browser = replicas.browser();
    await browser.signIn(alice);
    for (const replica of [replicas.a, replicas.b]) {
      await replica.shutdown();
      expect((await browser.get('/api/session')).body).toMatchObject(operatorOf);
      await replica.restart();
      expect((await browser.to(replica).get('/api/session')).body).toMatchObject(operatorOf);
    }
  });

  it('keeps the Operator signed in when a Replica crashes', async () => {
    const browser = replicas.browser();
    await browser.to(replicas.a).signIn(alice);
    await replicas.a.crash();
    expect((await browser.get('/api/session')).body).toMatchObject(operatorOf);
  });

  it('finishes a sign-in when the Replica it started on has crashed', async () => {
    const browser = replicas.browser();
    const authorizeUrl = await browser.to(replicas.a).startSignIn();
    await replicas.a.crash();
    await browser.get(await browser.approveAtProvider(authorizeUrl, alice));
    expect((await browser.get('/api/session')).body).toMatchObject(operatorOf);
  });

  it.each(['a', 'b'] as const)('ends the session everywhere when the Operator signs out on Replica %s', async (name) => {
    const browser = replicas.browser();
    await browser.signIn(alice);
    const copy = replicas.browser();
    for (const [k, v] of browser.cookies) copy.cookies.set(k, v);
    // Both have served the session, so both hold it live.
    await browser.to(replicas.a).get('/api/session');
    await browser.to(replicas.b).get('/api/session');

    expect((await browser.to(replicas[name]).post('/auth/logout')).status).toBe(204);

    expect((await copy.to(replicas.a).get('/api/session')).status).toBe(401);
    expect((await copy.to(replicas.b).get('/api/session')).status).toBe(401);
  });

  describe('what the database holds', () => {
    it('encrypts access and refresh tokens at rest, with the key from the new secret', async () => {
      const browser = replicas.browser();
      await browser.signIn(alice);
      const { rows } = await replicas.database.query('SELECT id, tokens, operator FROM sessions');
      expect(rows.length).toBeGreaterThan(0);
      const row = rows.at(-1);

      // It is not readable as it stands: no JWT (eyJ...), and no token field.
      expect(row.tokens).not.toContain('eyJ');
      expect(row.tokens).not.toMatch(/accessToken|refreshToken/);

      // The key opens it, and shows real tokens were in there.
      const opened = JSON.parse(keySeal(testSessionEncryptionKey).open(row.tokens, row.id)!);
      expect(opened.accessToken).toMatch(/^eyJ/);
      expect(keySeal(testSessionSecret).open(row.tokens, row.id)).toBeNull();
    });

    it('holds no secret of a sign-in in progress in the clear', async () => {
      const browser = replicas.browser();
      const authorizeUrl = new URL(await browser.startSignIn());
      const { rows } = await replicas.database.query('SELECT sealed FROM sign_ins');
      const state = authorizeUrl.searchParams.get('state')!;
      expect(rows.length).toBeGreaterThan(0);
      expect(rows.some((row) => row.sealed.includes(state))).toBe(false);
    });

    it('still signs the cookie with the session secret, and refuses one signed otherwise', async () => {
      const browser = replicas.browser();
      await browser.signIn(alice);
      const value = decodeURIComponent(browser.cookies.get('volveran_session')!);
      const [id] = value.split('.');
      const { rows } = await replicas.database.query('SELECT 1 FROM sessions WHERE id = $1', [id]);
      expect(rows).toHaveLength(1);

      // The right id, without the session secret's signature, gets nowhere.
      const forged = replicas.browser();
      forged.cookies.set('volveran_session', id!);
      expect((await forged.get('/api/session')).status).toBe(401);
    });

    it("signs the Operator out when the key can no longer read a session's tokens", async () => {
      const browser = replicas.browser();
      await browser.signIn(alice);
      const id = decodeURIComponent(browser.cookies.get('volveran_session')!).split('.')[0]!;
      await replicas.database.query('UPDATE sessions SET tokens = $1 WHERE id = $2', [keySeal('another-key-of-at-least-32-characters-long').seal('{}', id), id]);
      // Not served yet by this one, so it must read the row.
      await replicas.b.shutdown();
      await replicas.b.restart();
      expect((await browser.to(replicas.b).get('/api/session')).status).toBe(401);
    });
  });
});

describe('the two-Replica harness', () => {
  const QUEUE = 'two-replica-harness.dlq';
  const checkouts = `/api/profiles/dev/vhosts/%2F/queues/${QUEUE}/checkouts`;
  let replicas: TwoReplicas;
  beforeAll(async () => {
    await withChannel('/', async (ch) => {
      await ch.deleteQueue(QUEUE);
      await ch.assertQueue(QUEUE, { durable: true });
    });
    replicas = await startTwoReplicas({ profiles: [testProfile({ name: 'dev' })] });
  });
  afterAll(async () => {
    await replicas?.close();
    await withChannel('/', (ch) => ch.deleteQueue(QUEUE));
  });
  afterEach(async () => {
    for (const replica of [replicas.a, replicas.b]) if (!replica.running) await replica.restart();
    await purgeQueues('/', [QUEUE]);
  });

  it('sends each request to a chosen Replica, or to both over many random ones', async () => {
    expect(replicas.a.baseUrl).not.toBe(replicas.b.baseUrl);
    const chosen = new Set(Array.from({ length: 50 }, () => replicas.random().name));
    expect(chosen).toEqual(new Set(['a', 'b']));
    expect((await replicas.a.get('/healthz')).status).toBe(200);
    expect((await replicas.b.get('/healthz')).status).toBe(200);
  });

  it('never sends a random request to a stopped Replica', async () => {
    await replicas.a.shutdown();
    const browser = replicas.browser();
    for (let i = 0; i < 10; i++) {
      expect(replicas.random().name).toBe('b');
      expect((await browser.get('/healthz')).status).toBe(200);
    }
  });

  it('crashes a Replica abruptly: unreachable, its Messages back, and nothing more written', async () => {
    await seedMessages('/', QUEUE, 3);
    const browser = replicas.browser();
    await browser.signIn({ sub: 'crash-sub' });
    const started = await browser.to(replicas.a).post(checkouts);
    expect(started.status).toBe(201);
    const url = replicas.a.baseUrl;
    const entries = async () => (await replicas.database.query('SELECT count(*) AS n FROM audit_entries')).rows[0].n;
    const before = await entries();

    await replicas.a.crash();

    await expect(fetch(`${url}/healthz`)).rejects.toThrow();
    await eventually(async () => expect(await readyCount('/', QUEUE)).toBe(3));
    expect(await entries()).toBe(before);
    // The other Replica is untouched and the queue is free again.
    expect((await browser.get('/api/session')).status).toBe(200);
    expect((await replicas.b.get('/readyz')).status).toBe(200);
  });

  it('shuts a Replica down gracefully: its Checkout ends through its normal path', async () => {
    await seedMessages('/', QUEUE, 3);
    const browser = replicas.browser();
    await browser.signIn({ sub: 'shutdown-sub' });
    expect((await browser.to(replicas.a).post(checkouts)).status).toBe(201);

    await replicas.a.shutdown();

    await eventually(async () => expect(await readyCount('/', QUEUE)).toBe(3));
    expect(replicas.a.running).toBe(false);
  });

  it('restarts a stopped Replica on the same store', async () => {
    const browser = replicas.browser();
    await browser.signIn({ sub: 'restart-sub' });
    await replicas.b.crash();
    await replicas.b.restart();
    expect((await browser.to(replicas.b).get('/api/session')).status).toBe(200);
  });
});

describe('sessions in memory', () => {
  // The store named in `env`, so this holds whichever one the suite runs on.
  it('stay out of the store on SQLite, so a restart signs everyone out', async () => {
    const dataDir = await makeTempDir('sessions-sqlite');
    const port = await closedPort();
    const baseUrl = `http://127.0.0.1:${port}`;
    const start = () => startApp({ profiles: [testProfile({ name: 'dev' })], port, dataDir, env: { ...teamModeEnv(baseUrl), VOLVERAN_POSTGRES_URL: undefined, VOLVERAN_SESSION_ENCRYPTION_KEY: undefined } });
    try {
      const first = await start();
      const browser = new TestBrowser(baseUrl);
      await browser.signIn(alice);
      expect((await browser.get('/api/session')).status).toBe(200);
      await first.close();

      const second = await start();
      expect((await browser.get('/api/session')).status).toBe(401);
      await second.close();
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  });
});
