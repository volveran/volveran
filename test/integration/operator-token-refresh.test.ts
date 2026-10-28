// Refreshing the Operator's token on a Broker Profile with `credentials:
// operatorToken` (ADR 0008): access tokens here last a few seconds (the
// provider proxy gives every token, refreshed ones too, that lifetime), so a
// Checkout outlives several of them only if Volverán refreshes the token and
// pushes it to the Checkout's connection with `update-secret`. When the
// provider refuses the refresh, the token runs out: the broker closes the
// connection (a Lost Checkout) and routes answer `broker_token_expired`.
import type * as amqp from 'amqplib';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { connectWithToken, managementWithToken, oauthBroker, oauthBrokerLog, signIn } from '../broker/oauth.js';
import { closedPort, sleep, startApp, type ProfileFixture, type TestApp } from './harness.js';
import { startShortTokenProvider, teamModeEnv, testOidc, TestBrowser, type ShortTokenProvider, type TestIdentity } from './oidc-provider.js';

const LIFETIME_SECONDS = 6;
const CLASSIC = 'token-refresh.dlq';
const QUORUM = 'token-refresh.quorum.dlq';
const DISCARD = { kind: 'discard', reason: 'bad payload' };
const checkoutPath = (queue: string) => `/api/profiles/tokens/vhosts/%2F/queues/${queue}/checkouts`;

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

/** A token of a setup user with full scopes (monitoring: it sees every connection) and the provider's default hour. */
const setupToken = async () =>
  (await signIn('token-refresh-setup', { claims: { scope: `${oauthBroker.fullScopes} rabbitmq.tag:monitoring` } })).accessToken;

async function withTokenChannel<T>(fn: (ch: amqp.ConfirmChannel) => Promise<T>): Promise<T> {
  const tc = await connectWithToken(await setupToken());
  try {
    return await fn(await tc.conn.createConfirmChannel());
  } finally {
    await tc.conn.close().catch(() => {});
  }
}

async function seed(queue: string, count: number): Promise<void> {
  await withTokenChannel(async (ch) => {
    for (let i = 0; i < count; i++) ch.sendToQueue(queue, Buffer.from(`m${i}`), { messageId: `${queue}-${i}`, persistent: true });
    await ch.waitForConfirms();
  });
}

/** Message ids and x-delivery-count of the ready Messages, in queue order (taken and put back). */
async function ready(queue: string): Promise<Array<{ id: string; deliveryCount: unknown }>> {
  return withTokenChannel(async (ch) => {
    const taken: amqp.GetMessage[] = [];
    for (let m = await ch.get(queue); m; m = await ch.get(queue)) taken.push(m);
    for (const m of taken) ch.nack(m, false, true);
    await ch.checkQueue(queue);
    return taken.map((m) => ({ id: String(m.properties.messageId), deliveryCount: m.properties.headers?.['x-delivery-count'] }));
  });
}

/** The broker's view of the Checkout connections on `queue`: user and when each connected. */
async function checkoutConnections(queue: string): Promise<Array<{ user: string; connectedAt: number }>> {
  const res = await managementWithToken('/connections', await setupToken());
  expect(res.status).toBe(200);
  return (res.body as any[])
    .filter((c) => c.client_properties?.connection_name === `volveran checkout / ${queue}`)
    .map((c) => ({ user: c.user, connectedAt: c.connected_at }));
}

describe("Refreshing the Operator's token", () => {
  let app: TestApp;
  let baseUrl: string;
  let provider: ShortTokenProvider;
  const logs: Array<Record<string, any>> = [];
  const open: Array<[TestBrowser, string]> = [];

  async function signedIn(sub: string) {
    const browser = new TestBrowser(baseUrl);
    await browser.signIn(identity(sub));
    return browser;
  }

  async function start(browser: TestBrowser, queue: string) {
    const started = await browser.post(checkoutPath(queue));
    expect(started.status, JSON.stringify(started.body)).toBe(201);
    open.push([browser, started.body.checkout.id]);
    return started.body.checkout;
  }

  beforeAll(async () => {
    await withTokenChannel(async (ch) => {
      await ch.assertQueue(CLASSIC, { durable: true });
      await ch.assertQueue(QUORUM, { durable: true, arguments: { 'x-queue-type': 'quorum' } });
    });
  });
  afterEach(async () => {
    for (const [browser, id] of open.splice(0)) await browser.request('DELETE', `/api/checkouts/${id}`);
    await app?.close();
    await provider?.close();
    await withTokenChannel(async (ch) => {
      await ch.purgeQueue(CLASSIC);
      await ch.purgeQueue(QUORUM);
    });
  });
  afterAll(async () => {
    await withTokenChannel(async (ch) => {
      await ch.deleteQueue(CLASSIC);
      await ch.deleteQueue(QUORUM);
    });
  });

  async function startWithShortTokens() {
    provider = await startShortTokenProvider(LIFETIME_SECONDS);
    const port = await closedPort();
    baseUrl = `http://127.0.0.1:${port}`;
    logs.length = 0;
    app = await startApp({ profiles: [profile], port, env: teamModeEnv(baseUrl, provider.issuer), logs });
  }

  it('keeps a Checkout open through several token lifetimes on one connection, updating its secret, and still Applies', async () => {
    await startWithShortTokens();
    await seed(CLASSIC, 2);
    const browser = await signedIn('token-refresh-rita');
    const checkout = await start(browser, CLASSIC);
    // The management API lists a connection once its first stats are in.
    let connections = await checkoutConnections(CLASSIC);
    for (let i = 0; i < 40 && connections.length === 0; i++) {
      await sleep(250);
      connections = await checkoutConnections(CLASSIC);
    }
    const [connection] = connections;
    expect(connection).toMatchObject({ user: 'token-refresh-rita' });

    await sleep(3 * LIFETIME_SECONDS * 1000 + 1_000);

    // Without update-secret the broker closes the connection at the first token's expiry (320 "credential expired").
    expect((await browser.get(`/api/checkouts/${checkout.id}`)).body.checkout.status).toBe('active');
    expect(await checkoutConnections(CLASSIC)).toEqual([connection]);
    expect(provider.refreshes()).toBeGreaterThanOrEqual(3);
    const updates = oauthBrokerLog()
      .split('\n')
      .filter((line) => line.includes(`volveran checkout / ${CLASSIC}: user 'token-refresh-rita' updated secret`));
    expect(updates.length).toBeGreaterThanOrEqual(3);
    // Management API calls send the current token.
    expect((await browser.get('/api/profiles/tokens/vhosts/%2F/queues')).status).toBe(200);

    const decided = await browser.post(`/api/checkouts/${checkout.id}/decisions`, {
      handles: [checkout.messages[0].handle],
      decision: DISCARD,
    });
    expect(decided.status).toBe(200);
    const applied = await browser.post(`/api/checkouts/${checkout.id}/apply`, { confirm: true });
    expect(applied.status, JSON.stringify(applied.body)).toBe(200);
    expect(applied.body.outcomes.map((o: any) => o.status)).toEqual(['done', 'kept']);
    expect((await ready(CLASSIC)).map((m) => m.id)).toEqual([`${CLASSIC}-1`]);
    const entries = (await browser.get(`/api/audit-entries?checkoutId=${checkout.id}`)).body.entries;
    expect(entries).toEqual([expect.objectContaining({ action: 'discard', brokerUser: 'token-refresh-rita' })]);

    // Neither token reaches a log line (a JWT starts "eyJ").
    expect(logs.length).toBeGreaterThan(0);
    expect(JSON.stringify(logs)).not.toMatch(/eyJ[\w-]+\.eyJ/);
  }, 60_000);

  it('loses the Checkout when the provider refuses the refresh, costing only the Lost Checkout\'s one delivery, then answers broker_token_expired', async () => {
    await startWithShortTokens();
    await seed(QUORUM, 2);
    const browser = await signedIn('token-refresh-sam');
    provider.refuseRefreshes();
    const checkout = await start(browser, QUORUM);
    expect(checkout.heldCount).toBe(2);

    let view: any;
    for (let i = 0; i < 80; i++) {
      view = (await browser.get(`/api/checkouts/${checkout.id}`)).body.checkout;
      if (view.status !== 'active') break;
      await sleep(250);
    }
    expect(view.status).toBe('lost');
    expect(view.lostReason).toMatch(/credential expired/i);
    expect(view.lostReason).toContain('used up 1 of the Delivery Budget of each');
    expect(await ready(QUORUM)).toEqual([
      { id: `${QUORUM}-0`, deliveryCount: 1 },
      { id: `${QUORUM}-1`, deliveryCount: 1 },
    ]);
    expect(provider.refreshes()).toBeGreaterThanOrEqual(1);

    for (const res of [await browser.get('/api/profiles/tokens/vhosts/%2F/queues'), await browser.post(checkoutPath(QUORUM))]) {
      expect(res.status).toBe(401);
      expect(res.body.error).toMatchObject({ code: 'broker_token_expired', profile: 'tokens', signInUrl: '/auth/login' });
    }
    expect(logs).toContainEqual(expect.objectContaining({ level: 40, operator: 'token-refresh-sam', reason: expect.stringContaining('invalid_grant') }));
    expect(JSON.stringify(logs)).not.toMatch(/eyJ[\w-]+\.eyJ/);
  }, 40_000);
});
