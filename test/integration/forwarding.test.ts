// A Checkout lives on its Owner Replica, and any Replica serves it by forwarding (#92).
// Everything here is asserted through what an Operator sees on either Replica.
import { rm } from 'node:fs/promises';
import { setTimeout as sleep } from 'node:timers/promises';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { closedPort, eventually, makeTempDir, purgeQueues, readyCount, seedMessages, startApp, testProfile, withChannel } from './harness.js';
import { startTwoReplicas, type Replica, type ReplicaBrowser, type TwoReplicas } from './two-replicas.js';
import { teamModeEnv, TestBrowser } from './oidc-provider.js';

const QUEUE = 'forwarding.dlq';
const ana = { sub: 'ana-sub', email: 'ana@example.com', groups: ['ops'] };
const ben = { sub: 'ben-sub', email: 'ben@example.com', groups: ['ops'] };
const startPath = `/api/profiles/dev/vhosts/%2F/queues/${QUEUE}/checkouts`;
const profile = () => testProfile({ name: 'dev', roles: { operator: ['ops'] } });
const encoded = (operator: object) => Buffer.from(JSON.stringify(operator)).toString('base64url');
const OPERATOR_HEADER = 'x-volveran-forwarded-operator';

async function resetQueue(): Promise<void> {
  await withChannel('/', async (ch) => {
    await ch.assertQueue(QUEUE, { durable: true });
  });
  await purgeQueues('/', [QUEUE]);
}

describe('a Checkout through either Replica', () => {
  let replicas: TwoReplicas;
  let browser: ReplicaBrowser;
  const started: Array<{ id: string; owner: Replica; on: ReplicaBrowser }> = [];

  const startOn = async (owner: Replica, on: ReplicaBrowser = browser): Promise<string> => {
    await seedMessages('/', QUEUE, 2);
    const answer = await on.to(owner).post(startPath, {});
    expect(answer.status).toBe(201);
    const { id } = answer.body.checkout as { id: string };
    started.push({ id, owner, on });
    return id;
  };

  beforeAll(async () => {
    await resetQueue();
    replicas = await startTwoReplicas({ profiles: [profile()] });
    browser = replicas.browser();
    await browser.signIn(ana);
  });
  afterAll(async () => {
    await replicas?.close();
  });
  afterEach(async () => {
    for (const { id, owner, on } of started.splice(0)) if (owner.running) await on.to(owner).post(`/api/checkouts/${id}/end`);
    await purgeQueues('/', [QUEUE]);
  });

  it.each(['a', 'b'] as const)('shows the same Checkout whichever Replica is asked, when %s owns it', async (name) => {
    const owner = replicas[name];
    const id = await startOn(owner);
    const fromOwner = await browser.to(owner).get(`/api/checkouts/${id}`);
    const fromOther = await browser.to(replicas.other(owner)).get(`/api/checkouts/${id}`);
    expect(fromOther.status).toBe(200);
    expect(fromOther.body.checkout.id).toBe(id);
    expect(fromOther.body.checkout.status).toBe('active');
    expect(fromOther.body.checkout.messages).toHaveLength(2);
    expect(fromOther.body.checkout.messages).toEqual(fromOwner.body.checkout.messages);
  });

  it('answers a view of a Checkout on every request, wherever it lands', async () => {
    const id = await startOn(replicas.a);
    for (let i = 0; i < 10; i++) {
      const view = await browser.get(`/api/checkouts/${id}`);
      expect(view.status).toBe(200);
      expect(view.body.checkout.id).toBe(id);
    }
  });

  it('says a Checkout that does not exist does not exist, on both', async () => {
    for (const replica of [replicas.a, replicas.b]) {
      const view = await browser.to(replica).get('/api/checkouts/no-such-checkout');
      expect(view.status).toBe(404);
      expect(view.body.error.code).toBe('checkout_not_found');
    }
  });

  it('shows a Checkout that has ended, with its reason, through the other Replica too', async () => {
    const id = await startOn(replicas.a);
    expect((await browser.to(replicas.a).post(`/api/checkouts/${id}/end`)).status).toBe(200);
    const view = await browser.to(replicas.b).get(`/api/checkouts/${id}`);
    expect(view.status).toBe(200);
    expect(view.body.checkout.status).toBe('ended');
    expect(view.body.checkout.endReason).toBe('operator');
  });

  it("tells either Replica's /api/session of the Operator's active Checkout, and not once it has ended", async () => {
    const id = await startOn(replicas.b);
    expect((await browser.to(replicas.a).get('/api/session')).body.checkoutId).toBe(id);
    expect((await browser.to(replicas.b).get('/api/session')).body.checkoutId).toBe(id);
    await browser.to(replicas.b).post(`/api/checkouts/${id}/end`);
    await eventually(async () => {
      expect((await browser.to(replicas.a).get('/api/session')).body.checkoutId).toBeNull();
    });
    expect((await browser.to(replicas.b).get('/api/session')).body.checkoutId).toBeNull();
  });

  it('carries the Operator: another Operator is refused through the other Replica as on the owner', async () => {
    const id = await startOn(replicas.a);
    const other = replicas.browser();
    await other.signIn(ben);
    for (const replica of [replicas.a, replicas.b]) {
      const view = await other.to(replica).get(`/api/checkouts/${id}`);
      expect(view.status).toBe(403);
      expect(view.body.error.code).toBe('not_checkout_owner');
      const beat = await other.to(replica).post(`/api/checkouts/${id}/heartbeat`);
      expect(beat.status).toBe(403);
    }
  });

  it("checks the Role on the owner from the groups it was forwarded with", async () => {
    const id = await startOn(replicas.a);
    const res = await fetch(`${replicas.a.forwardingUrl}/api/checkouts/${id}`, {
      headers: { authorization: `Bearer ${replicas.forwardingSecret}`, [OPERATOR_HEADER]: encoded({ id: ana.sub, displayName: ana.email, groups: ['nobody'] }) },
    });
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('no_role_on_profile');
  });

  it('asks for a sign-in before forwarding anything', async () => {
    const id = await startOn(replicas.a);
    const view = await replicas.b.get(`/api/checkouts/${id}`);
    expect(view.status).toBe(401);
    expect(view.body.error.code).toBe('not_signed_in');
  });

  describe('the forwarding port', () => {
    let id: string;
    const send = (headers: Record<string, string>, path = `/api/checkouts/${id}`) => fetch(replicas.a.forwardingUrl + path, { headers });
    const anaHeader = () => encoded({ id: ana.sub, displayName: ana.email, groups: ana.groups });

    beforeEach(async () => {
      id = await startOn(replicas.a);
    });

    it('answers a request with the secret and an Operator', async () => {
      const res = await send({ authorization: `Bearer ${replicas.forwardingSecret}`, [OPERATOR_HEADER]: anaHeader() });
      expect(res.status).toBe(200);
    });

    it.each([
      ['nothing', () => ({})],
      ['an Operator without the secret', () => ({ [OPERATOR_HEADER]: anaHeader() })],
      ['the wrong secret', () => ({ authorization: 'Bearer wrong', [OPERATOR_HEADER]: anaHeader() })],
      ['the secret without an Operator', () => ({ authorization: `Bearer ${replicas.forwardingSecret}` })],
      ['the secret with an unreadable Operator', () => ({ authorization: `Bearer ${replicas.forwardingSecret}`, [OPERATOR_HEADER]: 'not-json' })],
    ])('refuses %s', async (_, headers) => {
      const res = await send(headers());
      expect(res.status).toBe(401);
      const body = (await res.json()) as { error: { code: string } };
      expect(body.error.code).toBe('forwarding_refused');
    });

    it('serves only the API', async () => {
      const res = await send({ authorization: `Bearer ${replicas.forwardingSecret}`, [OPERATOR_HEADER]: anaHeader() }, '/auth/login');
      expect(res.status).toBe(401);
    });

    it('means nothing on the web port, secret or not', async () => {
      for (const replica of [replicas.a, replicas.b]) {
        const res = await fetch(`${replica.baseUrl}/api/checkouts/${id}`, {
          headers: { authorization: `Bearer ${replicas.forwardingSecret}`, [OPERATOR_HEADER]: anaHeader() },
        });
        expect(res.status).toBe(401);
      }
    });
  });

  it('answers that the owner cannot be reached, not that the Checkout is gone, and its Messages come back', async () => {
    const twoMore = await startTwoReplicas({ profiles: [profile()] });
    try {
      const own = twoMore.browser();
      await own.signIn(ana);
      await seedMessages('/', QUEUE, 2);
      const answer = await own.to(twoMore.a).post(startPath, {});
      expect(answer.status).toBe(201);
      const { id } = answer.body.checkout as { id: string };
      await twoMore.a.crash();
      const view = await own.to(twoMore.b).get(`/api/checkouts/${id}`);
      expect(view.status).toBe(503);
      expect(view.body.error.code).toBe('replica_unreachable');
      expect(view.body.error.tryAgain).toBe(true);
      await eventually(async () => expect(await readyCount('/', QUEUE)).toBe(2));
    } finally {
      await twoMore.close();
    }
  });

  it('removes what a Replica shutting down leaves behind', async () => {
    const twoMore = await startTwoReplicas({ profiles: [profile()] });
    try {
      const own = twoMore.browser();
      await own.signIn(ana);
      await seedMessages('/', QUEUE, 2);
      const { id } = (await own.to(twoMore.a).post(startPath, {})).body.checkout as { id: string };
      await twoMore.a.shutdown();
      const view = await own.to(twoMore.b).get(`/api/checkouts/${id}`);
      expect(view.status).toBe(404);
      expect((await twoMore.database.query('SELECT 1 FROM replicas')).rows).toHaveLength(1);
      expect((await twoMore.database.query('SELECT 1 FROM live_checkouts')).rows).toHaveLength(0);
    } finally {
      await twoMore.close();
    }
  });
});

describe('a heartbeat through the other Replica', () => {
  let replicas: TwoReplicas;
  let browser: ReplicaBrowser;
  const WINDOW_MS = 1_500;

  beforeAll(async () => {
    await resetQueue();
    replicas = await startTwoReplicas({ profiles: [profile()], checkoutTiming: { heartbeatWindowMs: WINDOW_MS } });
    browser = replicas.browser();
    await browser.signIn(ana);
  });
  afterAll(async () => {
    await replicas?.close();
  });

  it('keeps the Checkout alive past its window, and without it the Checkout ends', async () => {
    await seedMessages('/', QUEUE, 1);
    const { id } = (await browser.to(replicas.a).post(startPath, {})).body.checkout as { id: string };
    const deadline = Date.now() + WINDOW_MS * 2.5;
    while (Date.now() < deadline) {
      const beat = await browser.to(replicas.b).post(`/api/checkouts/${id}/heartbeat`);
      expect(beat.status).toBe(200);
      expect(beat.body.checkout.status).toBe('active');
      await sleep(WINDOW_MS / 5);
    }
    await eventually(async () => {
      const view = await browser.to(replicas.b).get(`/api/checkouts/${id}`);
      expect(view.body.checkout.status).toBe('ended');
      expect(view.body.checkout.endReason).toBe('no-heartbeat');
    });
  });
});

describe('the lease', () => {
  it('stays live by being renewed, long past how long one renewal holds', async () => {
    await resetQueue();
    const replicas = await startTwoReplicas({ profiles: [profile()], replicaLeaseTiming: { renewEveryMs: 100, holdsForMs: 400 } });
    try {
      const browser = replicas.browser();
      await browser.signIn(ana);
      await seedMessages('/', QUEUE, 1);
      const { id } = (await browser.to(replicas.a).post(startPath, {})).body.checkout as { id: string };
      await sleep(1_200);
      expect((await browser.to(replicas.b).get(`/api/checkouts/${id}`)).status).toBe(200);
      await browser.to(replicas.a).post(`/api/checkouts/${id}/end`);
    } finally {
      await replicas.close();
    }
  });
});

describe('a Replica on its own', () => {
  const forwardingEnv = async () => {
    const port = await closedPort();
    return { port, env: { VOLVERAN_FORWARDING_SECRET: 'x'.repeat(32), VOLVERAN_FORWARDING_PORT: String(port), VOLVERAN_FORWARDING_ADDRESS: `127.0.0.1:${port}` } };
  };

  it('on SQLite registers nothing and opens no port, secret or not', async () => {
    await resetQueue();
    const dataDir = await makeTempDir('forwarding-sqlite');
    const { port, env } = await forwardingEnv();
    const appPort = await closedPort();
    const app = await startApp({
      port: appPort,
      dataDir,
      profiles: [profile()],
      env: { ...teamModeEnv(`http://127.0.0.1:${appPort}`), VOLVERAN_POSTGRES_URL: undefined, ...env },
    });
    try {
      await expect(fetch(`http://127.0.0.1:${port}/api/session`)).rejects.toThrow();
      const browser = new TestBrowser(app.baseUrl);
      await browser.signIn(ana);
      await seedMessages('/', QUEUE, 1);
      const started = await browser.post(startPath);
      expect(started.status).toBe(201);
      expect((await browser.get(`/api/checkouts/${started.body.checkout.id}`)).status).toBe(200);
      expect((await browser.get('/api/session')).body.checkoutId).toBe(started.body.checkout.id);
      await browser.post(`/api/checkouts/${started.body.checkout.id}/end`);
    } finally {
      await app.close();
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it('in Solo Mode opens no port, secret or not', async () => {
    const { port, env } = await forwardingEnv();
    const app = await startApp({ profiles: [testProfile({ name: 'dev' })], env });
    try {
      await expect(fetch(`http://127.0.0.1:${port}/api/session`)).rejects.toThrow();
    } finally {
      await app.close();
    }
  });
});

it("refuses a forwarding port that is the web app's", async () => {
  const port = await closedPort();
  await expect(
    startApp({
      port,
      profiles: [testProfile({ name: 'dev' })],
      env: {
        ...teamModeEnv(`http://127.0.0.1:${port}`),
        VOLVERAN_POSTGRES_URL: 'postgres://nobody@127.0.0.1:1/none',
        VOLVERAN_FORWARDING_SECRET: 'x'.repeat(32),
        VOLVERAN_FORWARDING_PORT: String(port),
        VOLVERAN_FORWARDING_ADDRESS: `127.0.0.1:${port}`,
      },
    }),
  ).rejects.toThrow('VOLVERAN_FORWARDING_PORT must differ');
});
