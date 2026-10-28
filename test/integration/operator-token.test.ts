// Broker Profiles with `credentials: operatorToken` (ADR 0008), against the
// OAuth 2.0 test broker: Volverán connects with the signed-in Operator's own
// access token, so the broker applies their permissions and knows them by
// name. The mock provider merges the sign-in claims into the access token,
// so each identity carries the broker's audience and the scopes it is given
// (the `azp` keeps the ID token, which gets them too, acceptable to Volverán).
import type * as amqp from 'amqplib';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { connectWithToken, oauthBroker, signIn } from '../broker/oauth.js';
import { closedPort, sleep, startApp, type ProfileFixture, type TestApp } from './harness.js';
import { teamModeEnv, testOidc, TestBrowser, type TestIdentity } from './oidc-provider.js';

const QUEUE = 'operator-token.dlq';
const DISCARD = { kind: 'discard', reason: 'bad payload' };
const checkoutPath = (profile: string) => `/api/profiles/${profile}/vhosts/%2F/queues/${QUEUE}/checkouts`;

/** Access token claims the OAuth 2.0 test broker accepts, with these scopes. */
const brokerClaims = (scope: string) => ({ aud: [testOidc.clientId, oauthBroker.audience], azp: testOidc.clientId, scope });
const FULL = oauthBroker.fullScopes;

const rita: TestIdentity = { sub: 'token-rita', email: 'rita@example.com', preferred_username: 'rita.r', ...brokerClaims(FULL) };
const alan: TestIdentity = { sub: 'token-alan', email: 'alan@example.com', ...brokerClaims('rabbitmq.tag:management') };
// May take the lock queue and see the vhost, but not read QUEUE.
const vera: TestIdentity = {
  sub: 'token-vera',
  email: 'vera@example.com',
  ...brokerClaims('rabbitmq.configure:*/volveran.* rabbitmq.read:*/other.* rabbitmq.tag:management'),
};

// Reads, configures and sees everything, but may not publish.
const wanda: TestIdentity = {
  sub: 'token-wanda',
  email: 'wanda@example.com',
  ...brokerClaims('rabbitmq.configure:*/* rabbitmq.read:*/* rabbitmq.tag:management'),
};
const OTHER = 'operator-token.other';

const tokenProfile = (name: string, extra: Partial<ProfileFixture> = {}): ProfileFixture => ({
  name,
  managementUrl: oauthBroker.managementUrl,
  amqpUrl: `amqp://${oauthBroker.host}:${oauthBroker.amqpPort}`,
  credentials: 'operatorToken',
  vhosts: ['/'],
  ...extra,
});

/** A confirm channel on the OAuth 2.0 broker, as a setup user with full scopes. */
async function withTokenChannel<T>(fn: (ch: amqp.ConfirmChannel) => Promise<T>): Promise<T> {
  const tc = await connectWithToken((await signIn('operator-token-setup')).accessToken);
  try {
    return await fn(await tc.conn.createConfirmChannel());
  } finally {
    await tc.conn.close().catch(() => {});
  }
}

async function seed(count: number): Promise<void> {
  await withTokenChannel(async (ch) => {
    for (let i = 0; i < count; i++) ch.sendToQueue(QUEUE, Buffer.from(`m${i}`), { messageId: `${QUEUE}-${i}`, persistent: true });
    await ch.waitForConfirms();
  });
}

/** The message ids of the ready Messages, in queue order (taken and put back). */
async function readyIds(): Promise<string[]> {
  return withTokenChannel(async (ch) => {
    const taken: amqp.GetMessage[] = [];
    for (let m = await ch.get(QUEUE); m; m = await ch.get(QUEUE)) taken.push(m);
    for (const m of taken) ch.nack(m, false, true);
    await ch.checkQueue(QUEUE);
    return taken.map((m) => String(m.properties.messageId));
  });
}

describe('Broker Profile with the Operator\'s own token', () => {
  let app: TestApp;
  let baseUrl: string;
  const open: Array<[TestBrowser, string]> = [];

  async function signedIn(identity: TestIdentity) {
    const browser = new TestBrowser(baseUrl);
    await browser.signIn(identity);
    return browser;
  }

  async function checkoutWithDiscard(browser: TestBrowser, profile: string) {
    const started = await browser.post(checkoutPath(profile));
    expect(started.status, JSON.stringify(started.body)).toBe(201);
    const { id, messages } = started.body.checkout;
    open.push([browser, id]);
    const decided = await browser.post(`/api/checkouts/${id}/decisions`, { handles: [messages[0].handle], decision: DISCARD });
    expect(decided.status).toBe(200);
    return id as string;
  }

  beforeAll(async () => {
    await withTokenChannel(async (ch) => {
      await ch.assertQueue(QUEUE, { durable: true });
      await ch.assertQueue(OTHER, { durable: true });
    });
    const port = await closedPort();
    baseUrl = `http://127.0.0.1:${port}`;
    app = await startApp({
      profiles: [
        tokenProfile('tokens'),
        tokenProfile('tokens-named', { tokenUsernameClaim: 'preferred_username' }),
        tokenProfile('tokens-prod', { protected: true }),
      ],
      port,
      env: teamModeEnv(baseUrl),
    });
  });
  afterEach(async () => {
    for (const [browser, id] of open.splice(0)) await browser.request('DELETE', `/api/checkouts/${id}`);
    await withTokenChannel(async (ch) => {
      await ch.purgeQueue(QUEUE);
      await ch.purgeQueue(OTHER);
    });
  });
  afterAll(async () => {
    await app?.close();
    await withTokenChannel(async (ch) => {
      await ch.deleteQueue(QUEUE);
      await ch.deleteQueue(OTHER);
    });
  });

  it('lists the queues, starts a Checkout and Applies as the Operator, recording their broker identity', async () => {
    await seed(2);
    const browser = await signedIn(rita);
    const profiles = (await browser.get('/api/profiles')).body.profiles;
    expect(profiles[0]).toMatchObject({ name: 'tokens', credentials: 'operatorToken', username: null, passwordEnv: null });
    const list = await browser.get('/api/profiles/tokens/vhosts/%2F/queues');
    expect(list.status, JSON.stringify(list.body)).toBe(200);
    expect(list.body.queues.map((q: any) => q.name)).toContain(QUEUE);

    const id = await checkoutWithDiscard(browser, 'tokens');
    const applied = await browser.post(`/api/checkouts/${id}/apply`, { confirm: true });
    expect(applied.status, JSON.stringify(applied.body)).toBe(200);
    expect(applied.body.outcomes.map((o: any) => o.status)).toEqual(['done', 'kept']);
    expect(await readyIds()).toEqual([`${QUEUE}-1`]);

    const entries = (await browser.get(`/api/audit-entries?checkoutId=${id}`)).body.entries;
    expect(entries).toEqual([expect.objectContaining({ action: 'discard', operatorId: 'token-rita', brokerUser: 'token-rita' })]);
  });

  it('records the tokenUsernameClaim as the broker user', async () => {
    await seed(1);
    const browser = await signedIn(rita);
    const id = await checkoutWithDiscard(browser, 'tokens-named');
    expect((await browser.post(`/api/checkouts/${id}/apply`, { confirm: true })).status).toBe(200);
    const entries = (await browser.get(`/api/audit-entries?checkoutId=${id}`)).body.entries;
    expect(entries).toEqual([expect.objectContaining({ brokerUser: 'rita.r' })]);
  });

  it('answers broker_permission_denied, naming the queue and the permission, when the token may not read the queue', async () => {
    await seed(2);
    const browser = await signedIn(vera);
    const refused = await browser.post(checkoutPath('tokens'));
    expect(refused.status, JSON.stringify(refused.body)).toBe(403);
    expect(refused.body.error).toMatchObject({
      code: 'broker_permission_denied',
      profile: 'tokens',
      brokerUser: 'token-vera',
      resource: { type: 'queue', name: QUEUE, vhost: '/' },
      permission: 'read',
    });
    expect(refused.body.error.message).toContain(`read permission on queue "${QUEUE}"`);
    expect(await readyIds()).toEqual([`${QUEUE}-0`, `${QUEUE}-1`]);
    // The refused start leaves no Checkout behind.
    expect((await browser.get('/api/session')).body.checkoutId).toBeNull();
  });

  it('fails a Move the token may not publish, naming the exchange and the permission, and keeps the Message', async () => {
    await seed(2);
    const browser = await signedIn(wanda);
    const started = await browser.post(checkoutPath('tokens'));
    expect(started.status, JSON.stringify(started.body)).toBe(201);
    const { id, messages } = started.body.checkout;
    open.push([browser, id]);
    const move = { kind: 'move', destination: { queue: OTHER } };
    expect((await browser.post(`/api/checkouts/${id}/decisions`, { handles: [messages[0].handle], decision: move })).status).toBe(200);
    const applied = await browser.post(`/api/checkouts/${id}/apply`, { confirm: true });
    expect(applied.status, JSON.stringify(applied.body)).toBe(200);
    const [moved] = applied.body.outcomes;
    expect(moved.status).toBe('failed');
    expect(moved.reason).toContain('The broker refused broker user "token-wanda" of Broker Profile "tokens" write permission on the default exchange in vhost "/"');
    expect(await readyIds()).toEqual([`${QUEUE}-0`, `${QUEUE}-1`]);
  });

  it('answers a Restore the token may not publish with broker_permission_denied, naming the exchange and the permission', async () => {
    await seed(1);
    const discarder = await signedIn(rita);
    const id = await checkoutWithDiscard(discarder, 'tokens');
    expect((await discarder.post(`/api/checkouts/${id}/apply`, { confirm: true })).status).toBe(200);
    open.splice(open.findIndex(([, o]) => o === id), 1);
    const [discard] = (await discarder.get(`/api/audit-entries?checkoutId=${id}`)).body.entries;

    const browser = await signedIn(wanda);
    const refused = await browser.post(`/api/audit-entries/${discard.id}/restore`, { confirm: true });
    expect(refused.status, JSON.stringify(refused.body)).toBe(403);
    expect(refused.body.error).toMatchObject({
      code: 'broker_permission_denied',
      profile: 'tokens',
      brokerUser: 'token-wanda',
      resource: { type: 'exchange', name: '', vhost: '/' },
      permission: 'write',
    });
    expect(await readyIds()).toEqual([]);
    const [restore] = (await browser.get(`/api/audit-entries?action=restore&profile=tokens`)).body.entries;
    expect(restore).toMatchObject({ restoreOf: discard.id, outcome: 'failed', brokerUser: 'token-wanda' });
    // The failed Restore leaves the Discard restorable by someone who may publish.
    expect((await discarder.post(`/api/audit-entries/${discard.id}/restore`, { confirm: true })).status).toBe(200);
    expect(await readyIds()).toEqual([`${QUEUE}-0`]);
  });

  it("runs an approved Apply on the requester's connection and token, not the approver's", async () => {
    await seed(2);
    const requester = await signedIn(rita);
    // The approver's token has no permission on the queue at all.
    const approver = await signedIn(alan);
    const id = await checkoutWithDiscard(requester, 'tokens-prod');
    const requested = await requester.post(`/api/checkouts/${id}/approval-request`, { confirm: true, confirmQueueName: QUEUE });
    expect(requested.status, JSON.stringify(requested.body)).toBe(200);

    const approved = await approver.post(`/api/approvals/${id}/approve`, { confirmQueueName: QUEUE });
    expect(approved.status, JSON.stringify(approved.body)).toBe(200);
    expect(approved.body.outcomes.map((o: any) => o.status)).toEqual(['done', 'kept']);
    expect(await readyIds()).toEqual([`${QUEUE}-1`]);

    const entries = (await requester.get(`/api/audit-entries?checkoutId=${id}`)).body.entries;
    expect(entries).toEqual([
      expect.objectContaining({ operatorId: 'token-rita', approverId: 'token-alan', brokerUser: 'token-rita', outcome: 'done' }),
    ]);
  });

  it('loses a live Checkout when the token expires, then answers broker_token_expired with a sign-in link', async () => {
    await seed(3);
    const expiresAt = Math.floor(Date.now() / 1000) + 8;
    const browser = await signedIn({ sub: 'token-sam', email: 'sam@example.com', ...brokerClaims(FULL), exp: expiresAt });
    const started = await browser.post(checkoutPath('tokens'));
    expect(started.status, JSON.stringify(started.body)).toBe(201);
    const { id } = started.body.checkout;
    open.push([browser, id]);
    expect(started.body.checkout.heldCount).toBe(3);

    // The broker closes the connection at the token's expiry: a Lost Checkout.
    let checkout: any;
    for (let i = 0; i < 80; i++) {
      checkout = (await browser.get(`/api/checkouts/${id}`)).body.checkout;
      if (checkout.status !== 'active') break;
      await sleep(250);
    }
    expect(checkout.status).toBe('lost');
    expect(checkout.lostReason).toMatch(/credential expired/i);
    expect(await readyIds()).toEqual([`${QUEUE}-0`, `${QUEUE}-1`, `${QUEUE}-2`]);

    for (const res of [await browser.get('/api/profiles/tokens/vhosts/%2F/queues'), await browser.post(checkoutPath('tokens'))]) {
      expect(res.status).toBe(401);
      expect(res.body.error).toMatchObject({ code: 'broker_token_expired', profile: 'tokens', signInUrl: '/auth/login' });
    }
  }, 40_000);
});
