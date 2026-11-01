// Refreshing the Operator's token with two Replicas (#114): each holds the token live, and
// the provider's refresh tokens work once, so a Replica refreshing with a token another has
// already rotated would be refused. Access tokens last a few seconds here.
import type * as amqp from 'amqplib';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { connectWithToken, managementWithToken, oauthBroker, oauthBrokerLog, signIn } from '../broker/oauth.js';
import { sleep, type ProfileFixture } from './harness.js';
import { startShortTokenProvider, testOidc, type ShortTokenProvider, type TestIdentity } from './oidc-provider.js';
import { startTwoReplicas, type Replica, type ReplicaBrowser, type TwoReplicas } from './two-replicas.js';

const LIFETIME_SECONDS = 6;
const QUEUE = 'token-refresh-replicas.dlq';
const TARGET = 'token-refresh-replicas.target';
const QUEUES = '/api/profiles/tokens/vhosts/%2F/queues';
const CHECKOUTS = `${QUEUES}/${QUEUE}/checkouts`;

const identity = (sub: string): TestIdentity => ({
  sub,
  email: `${sub}@example.com`,
  aud: [testOidc.clientId, oauthBroker.audience],
  azp: testOidc.clientId,
  scope: oauthBroker.fullScopes,
});

const profile: ProfileFixture = {
  name: 'tokens',
  managementUrl: oauthBroker.managementUrl,
  amqpUrl: `amqp://${oauthBroker.host}:${oauthBroker.amqpPort}`,
  credentials: 'operatorToken',
  vhosts: ['/'],
};

const setupToken = async () =>
  (await signIn('token-refresh-replicas-setup', { claims: { scope: `${oauthBroker.fullScopes} rabbitmq.tag:monitoring` } })).accessToken;

async function withTokenChannel<T>(fn: (ch: amqp.ConfirmChannel) => Promise<T>): Promise<T> {
  const tc = await connectWithToken(await setupToken());
  try {
    return await fn(await tc.conn.createConfirmChannel());
  } finally {
    await tc.conn.close().catch(() => {});
  }
}

async function seed(count: number): Promise<void> {
  await withTokenChannel(async (ch) => {
    for (let i = 0; i < count; i++) ch.sendToQueue(QUEUE, Buffer.from(`m${i}`), { messageId: `m-${i}`, persistent: true });
    await ch.waitForConfirms();
  });
}

async function checkoutConnections(): Promise<Array<{ user: string; connectedAt: number }>> {
  const res = await managementWithToken('/connections', await setupToken());
  return (res.body as any[])
    .filter((c) => c.client_properties?.connection_name === `volveran checkout / ${QUEUE}`)
    .map((c) => ({ user: c.user, connectedAt: c.connected_at }));
}

describe("Refreshing the Operator's token across two Replicas", () => {
  let replicas: TwoReplicas;
  let provider: ShortTokenProvider;
  const logs: Array<Record<string, any>> = [];
  const open: Array<[ReplicaBrowser, string]> = [];

  async function start() {
    logs.length = 0;
    // Long enough for the other Replica to reach the provider while one is waiting for it.
    provider = await startShortTokenProvider(LIFETIME_SECONDS, { refreshDelayMs: 500 });
    replicas = await startTwoReplicas({
      profiles: [profile],
      env: { VOLVERAN_OIDC_ISSUER: provider.issuer },
      perReplica: () => ({ logs }),
    });
  }

  async function signedInOn(replica: Replica, sub: string): Promise<ReplicaBrowser> {
    const browser = replicas.browser();
    const callback = await browser.approveAtProvider(await browser.to(replica).startSignIn(), identity(sub));
    expect((await browser.to(replica).get(callback)).status).toBe(302);
    return browser;
  }

  beforeAll(async () => {
    await withTokenChannel(async (ch) => {
      await ch.assertQueue(QUEUE, { durable: true });
      await ch.assertQueue(TARGET, { durable: true });
    });
  });
  afterEach(async () => {
    for (const [browser, id] of open.splice(0)) await browser.request('DELETE', `/api/checkouts/${id}`).catch(() => {});
    await replicas?.close();
    await provider?.close();
    await withTokenChannel((ch) => ch.purgeQueue(QUEUE));
  });
  afterAll(async () => {
    await withTokenChannel(async (ch) => {
      await ch.deleteQueue(QUEUE);
      await ch.deleteQueue(TARGET);
    });
  });

  it('saves a rotated token where the other Replica finds it, after the first has expired', async () => {
    await start();
    const browser = await signedInOn(replicas.a, 'token-replicas-rita');
    // Past the expiry of the token from sign-in, which the other Replica has never seen.
    await sleep(LIFETIME_SECONDS * 1000 + 500);
    expect(provider.refreshes()).toBeGreaterThanOrEqual(1);

    const queues = await browser.to(replicas.b).get(QUEUES);
    expect(queues.status, JSON.stringify(queues.body)).toBe(200);
  }, 60_000);

  it('leaves the session valid on both when both refresh at once', async () => {
    await start();
    const browser = await signedInOn(replicas.a, 'token-replicas-sam');
    expect((await browser.to(replicas.b).get(QUEUES)).status).toBe(200);

    await sleep(3 * LIFETIME_SECONDS * 1000 + 1_000);

    expect(provider.reusedRefreshTokens()).toBe(0);
    expect(provider.refreshes()).toBeGreaterThanOrEqual(3);
    for (const replica of [replicas.a, replicas.b]) {
      const queues = await browser.to(replica).get(QUEUES);
      expect(queues.status, JSON.stringify(queues.body)).toBe(200);
    }
    expect(logs.filter((l) => /refresh/i.test(String(l.msg)))).toEqual([]);
    expect(JSON.stringify(logs)).not.toMatch(/eyJ[\w-]+\.eyJ/);
  }, 60_000);

  it("keeps the Owner Replica's Checkout open on one connection, whichever Replica is asked, and after the other crashes", async () => {
    await start();
    await seed(1);
    // Signed in on the other: it refreshes first, so the Owner Replica finds the token rotated.
    const browser = await signedInOn(replicas.b, 'token-replicas-tess');
    const started = await browser.to(replicas.a).post(CHECKOUTS);
    expect(started.status, JSON.stringify(started.body)).toBe(201);
    const id = started.body.checkout.id;
    open.push([browser, id]);
    let connections = await checkoutConnections();
    for (let i = 0; i < 40 && connections.length === 0; i++) {
      await sleep(250);
      connections = await checkoutConnections();
    }
    const [connection] = connections;
    expect(connection).toMatchObject({ user: 'token-replicas-tess' });

    await sleep(2 * LIFETIME_SECONDS * 1000 + 1_000);

    expect((await browser.to(replicas.b).get(`/api/checkouts/${id}`)).body.checkout.status).toBe('active');
    expect(await checkoutConnections()).toEqual([connection]);
    expect(provider.reusedRefreshTokens()).toBe(0);
    const updates = oauthBrokerLog()
      .split('\n')
      .filter((line) => line.includes(`volveran checkout / ${QUEUE}: user 'token-replicas-tess' updated secret`));
    expect(updates.length).toBeGreaterThanOrEqual(2);

    // With the other gone, the Owner Replica refreshes for itself.
    await replicas.b.crash();
    const refreshes = provider.refreshes();
    await sleep(2 * LIFETIME_SECONDS * 1000);

    expect(provider.refreshes()).toBeGreaterThan(refreshes);
    const afterCrash = (await browser.to(replicas.a).get(`/api/checkouts/${id}`)).body.checkout;
    expect(afterCrash.status, `${afterCrash.lostReason}; reused refresh tokens: ${provider.reusedRefreshTokens()}; logs: ${JSON.stringify(logs.filter((l) => l.level >= 40).map((l) => [l.msg, l.reason]))}`).toBe('active');
    expect(await checkoutConnections()).toEqual([connection]);
  }, 90_000);

  it('checks a Move destination through the Replica that does not own the Checkout, with the token from the store', async () => {
    await start();
    await seed(1);
    const browser = await signedInOn(replicas.b, 'token-replicas-vera');
    const started = await browser.to(replicas.a).post(CHECKOUTS);
    expect(started.status, JSON.stringify(started.body)).toBe(201);
    const { id, messages } = started.body.checkout;
    open.push([browser, id]);

    const decide = (queue: string) =>
      browser.to(replicas.b).post(`/api/checkouts/${id}/decisions`, {
        handles: [messages[0].handle],
        decision: { kind: 'move', destination: { queue } },
      });

    // Past the expiry of the sign-in's token, so the check needs a refreshed one.
    await sleep(LIFETIME_SECONDS * 1000 + 500);
    const moved = await decide(TARGET);
    expect(moved.status, JSON.stringify(moved.body)).toBe(200);
    expect(moved.body.rejected).toEqual([]);

    // The check did reach the broker: a queue it does not have is refused.
    const nowhere = await decide('token-refresh-replicas.no-such-queue');
    expect(nowhere.status).toBe(422);
    expect(nowhere.body.error.code).toBe('decision_not_allowed');
  }, 60_000);

  it('prompts the Operator to sign in again on either Replica when the provider refuses the refresh', async () => {
    await start();
    await seed(1);
    const browser = await signedInOn(replicas.a, 'token-replicas-uma');
    expect((await browser.to(replicas.b).get(QUEUES)).status).toBe(200);
    provider.refuseRefreshes();
    const started = await browser.to(replicas.a).post(CHECKOUTS);
    expect(started.status, JSON.stringify(started.body)).toBe(201);
    const id = started.body.checkout.id;

    let view: any;
    for (let i = 0; i < 80; i++) {
      view = (await browser.to(replicas.b).get(`/api/checkouts/${id}`)).body.checkout;
      if (view.status !== 'active') break;
      await sleep(250);
    }
    expect(view.status).toBe('lost');
    expect(view.lostReason).toMatch(/credential expired/i);

    for (const replica of [replicas.a, replicas.b]) {
      const queues = await browser.to(replica).get(QUEUES);
      expect(queues.status).toBe(401);
      expect(queues.body.error).toMatchObject({ code: 'broker_token_expired', profile: 'tokens', signInUrl: '/auth/login' });
    }
    expect(logs).toContainEqual(expect.objectContaining({ level: 40, operator: 'token-replicas-uma', reason: expect.stringContaining('invalid_grant') }));
  }, 60_000);
});
