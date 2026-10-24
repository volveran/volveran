// Team Mode (ADR 0002): Operators sign in through an OIDC provider (the mock
// provider of test/broker/docker-compose.yml), every API route needs a
// session, and the Operator is the signed-in identity.
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { closedPort, purgeQueues, readyCount, seedMessages, startApp, testProfile, type TestApp } from './harness.js';
import { teamModeEnv, TestBrowser, testOidc } from './oidc-provider.js';

const alice = { sub: 'alice-sub-1', email: 'alice@example.com', name: 'Alice Doe' };

async function startTeamApp(options: { host?: string; env?: Record<string, string | undefined> } = {}) {
  const port = await closedPort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const app = await startApp({
    profiles: [testProfile({ name: 'dev' })],
    host: options.host ?? '127.0.0.1',
    port,
    env: { ...teamModeEnv(baseUrl), ...options.env },
  });
  return { app, baseUrl };
}

describe('Team Mode', () => {
  let app: TestApp;
  let baseUrl: string;
  beforeAll(async () => {
    ({ app, baseUrl } = await startTeamApp({ host: '0.0.0.0' }));
  });
  afterAll(async () => {
    await app?.close();
  });

  it('listens on the network', async () => {
    expect(app.baseUrl).toMatch(/^http:\/\/0\.0\.0\.0:/);
  });

  it.each(['/api/session', '/api/profiles', '/api/profiles/dev/vhosts', '/api/no-such-route'])(
    'refuses %s without a session',
    async (path) => {
      const res = await new TestBrowser(baseUrl).get(path);
      expect(res.status).toBe(401);
      expect(res.body.error).toMatchObject({ code: 'not_signed_in', signInUrl: '/auth/login' });
    },
  );

  it('signs an Operator in with the authorization code flow and PKCE', async () => {
    const browser = new TestBrowser(baseUrl);
    const authorizeUrl = new URL(await browser.startSignIn());
    expect(authorizeUrl.href.startsWith(`${testOidc.issuer}/authorize`)).toBe(true);
    expect(authorizeUrl.searchParams.get('client_id')).toBe(testOidc.clientId);
    expect(authorizeUrl.searchParams.get('response_type')).toBe('code');
    expect(authorizeUrl.searchParams.get('code_challenge_method')).toBe('S256');
    expect(authorizeUrl.searchParams.get('code_challenge')).toBeTruthy();
    expect(authorizeUrl.searchParams.get('redirect_uri')).toBe(`${baseUrl}/auth/callback`);
    expect(authorizeUrl.searchParams.get('scope')).toBe('openid email profile');

    const back = await browser.get(await browser.approveAtProvider(authorizeUrl.href, alice));
    expect(back.status).toBe(302);
    expect(back.location).toBe('/');

    const session = await browser.get('/api/session');
    expect(session.status).toBe(200);
    expect(session.body).toEqual({
      mode: 'team',
      operator: 'alice@example.com',
      operatorId: 'alice-sub-1',
      email: 'alice@example.com',
      name: 'Alice Doe',
      checkoutId: null,
    });
    expect((await browser.get('/api/profiles')).status).toBe(200);
  });

  it('keeps the session in a secret, HTTP-only cookie', async () => {
    const browser = new TestBrowser(baseUrl);
    const res = await browser.signIn(alice);
    const sessionCookie = res.setCookies.find((c) => c.startsWith('volveran_session='));
    expect(sessionCookie).toMatch(/HttpOnly/i);
    expect(sessionCookie).toMatch(/SameSite=Lax/i);
    expect(sessionCookie).toMatch(/Path=\//i);
    expect(sessionCookie).not.toContain('alice');
  });

  it('returns to the page sign-in started from', async () => {
    const res = await new TestBrowser(baseUrl).signIn(alice, '/queues?x=1');
    expect(res.location).toBe('/queues?x=1');
  });

  it('never returns to another site after sign-in', async () => {
    for (const returnTo of ['https://evil.example.com/', '//evil.example.com/', '/\\evil.example.com']) {
      expect((await new TestBrowser(baseUrl).signIn(alice, returnTo)).location).toBe('/');
    }
  });

  it('shows the name when the provider gives no email, and the sub when it gives neither', async () => {
    const named = new TestBrowser(baseUrl);
    await named.signIn({ sub: 'bob-sub', name: 'Bob' });
    expect((await named.get('/api/session')).body).toEqual({ mode: 'team', operator: 'Bob', operatorId: 'bob-sub', name: 'Bob', checkoutId: null });

    const bare = new TestBrowser(baseUrl);
    await bare.signIn({ sub: 'carol-sub' });
    expect((await bare.get('/api/session')).body).toEqual({ mode: 'team', operator: 'carol-sub', operatorId: 'carol-sub', checkoutId: null });
  });

  it('gives each signed-in person their own session', async () => {
    const a = new TestBrowser(baseUrl);
    const b = new TestBrowser(baseUrl);
    await a.signIn(alice);
    await b.signIn({ sub: 'bob-sub', email: 'bob@example.com' });
    expect((await a.get('/api/session')).body.operatorId).toBe('alice-sub-1');
    expect((await b.get('/api/session')).body.operatorId).toBe('bob-sub');
  });

  it('ends the session on sign-out, even for a copy of the cookie', async () => {
    const browser = new TestBrowser(baseUrl);
    await browser.signIn(alice);
    const stolen = new TestBrowser(baseUrl);
    for (const [k, v] of browser.cookies) stolen.cookies.set(k, v);

    const out = await browser.post('/auth/logout');
    expect(out.status).toBe(204);
    expect(browser.cookies.has('volveran_session')).toBe(false);
    expect((await stolen.get('/api/profiles')).status).toBe(401);
  });

  it('refuses a tampered session cookie', async () => {
    const browser = new TestBrowser(baseUrl);
    await browser.signIn(alice);
    const value = browser.cookies.get('volveran_session')!;
    browser.cookies.set('volveran_session', value.slice(0, -2) + (value.endsWith('A') ? 'BB' : 'AA'));
    expect((await browser.get('/api/session')).status).toBe(401);
  });

  it('refuses a callback whose state does not match the sign-in it started', async () => {
    const browser = new TestBrowser(baseUrl);
    const callback = new URL(await browser.approveAtProvider(await browser.startSignIn(), alice));
    callback.searchParams.set('state', 'forged');
    const res = await browser.get(callback.pathname + callback.search);
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('sign_in_failed');
    expect((await browser.get('/api/session')).status).toBe(401);
  });

  it('refuses a callback from a browser that did not start sign-in', async () => {
    const starter = new TestBrowser(baseUrl);
    const callback = new URL(await starter.approveAtProvider(await starter.startSignIn(), alice));
    const other = new TestBrowser(baseUrl);
    const res = await other.get(callback.pathname + callback.search);
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('sign_in_failed');
  });

  it('reports a sign-in the provider refused', async () => {
    const browser = new TestBrowser(baseUrl);
    const state = new URL(await browser.startSignIn()).searchParams.get('state')!;
    const res = await browser.get(`/auth/callback?error=access_denied&error_description=Not+allowed&state=${state}`);
    expect(res.status).toBe(400);
    expect(res.body.error).toMatchObject({ code: 'sign_in_failed' });
    expect(res.body.error.message).toMatch(/access_denied|Not allowed/);
  });
});

describe('Checkout in Team Mode', () => {
  const bob = { sub: 'bob-sub', name: 'Bob' };
  const checkoutPath = (queue: string) => `/api/profiles/dev/vhosts/%2F/queues/${encodeURIComponent(queue)}/checkouts`;
  let app: TestApp;
  let baseUrl: string;
  const open: Array<{ browser: TestBrowser; id: string }> = [];

  async function startCheckout(browser: TestBrowser, queue: string) {
    const res = await browser.post(checkoutPath(queue));
    if (res.status === 201) open.push({ browser, id: res.body.checkout.id });
    return res;
  }

  beforeAll(async () => {
    ({ app, baseUrl } = await startTeamApp());
  });
  afterEach(async () => {
    for (const { browser, id } of open.splice(0)) await browser.request('DELETE', `/api/checkouts/${id}`);
    await purgeQueues('/', ['orders.dlq', 'payments.dlq']);
  });
  afterAll(async () => {
    await app?.close();
  });

  it('gives each signed-in Operator one Checkout and names the holder to the other', async () => {
    await seedMessages('/', 'orders.dlq', 2);
    await seedMessages('/', 'payments.dlq', 1);
    const a = new TestBrowser(baseUrl);
    const b = new TestBrowser(baseUrl);
    await a.signIn(alice);
    await b.signIn(bob);

    const mine = await startCheckout(a, 'orders.dlq');
    expect(mine.status).toBe(201);
    expect(mine.body.checkout).toMatchObject({ operator: 'alice@example.com', heldCount: 2 });

    // Bob is refused the same queue, with Alice's display name.
    const refused = await startCheckout(b, 'orders.dlq');
    expect(refused.status).toBe(409);
    expect(refused.body.error).toMatchObject({
      code: 'checkout_in_progress',
      holder: { operator: 'alice@example.com', since: mine.body.checkout.startedAt },
    });
    expect(refused.body.error.message).toContain('already checked out: alice@example.com');

    // Alice's Checkout does not count against Bob: he holds a queue of his own.
    const his = await startCheckout(b, 'payments.dlq');
    expect(his.status).toBe(201);
    expect(his.body.checkout).toMatchObject({ operator: 'Bob', heldCount: 1 });

    // Each session returns to its own Checkout; a second one for Alice is refused.
    expect((await a.get('/api/session')).body.checkoutId).toBe(mine.body.checkout.id);
    expect((await b.get('/api/session')).body.checkoutId).toBe(his.body.checkout.id);
    const second = await startCheckout(a, 'payments.dlq');
    expect(second.status).toBe(409);
    expect(second.body.error).toMatchObject({ code: 'operator_has_checkout', checkoutId: mine.body.checkout.id });

    // The queue list names the holder by display name too.
    const list = (await b.get('/api/profiles/dev/vhosts/%2F/queues')).body.queues;
    expect(list.find((q: any) => q.name === 'orders.dlq').checkedOutBy).toMatchObject({ operator: 'alice@example.com' });

    expect((await a.request('DELETE', `/api/checkouts/${mine.body.checkout.id}`)).status).toBe(200);
    open.splice(open.findIndex((c) => c.id === mine.body.checkout.id), 1);
    expect((await a.get('/api/session')).body.checkoutId).toBeNull();
    expect(await readyCount('/', 'orders.dlq')).toBe(2);
  });

  describe("another Operator's Checkout", () => {
    // Each route under /api/checkouts/:id, with a body a valid request would carry.
    const routes: Array<[method: string, route: string, body?: unknown]> = [
      ['GET', '/api/checkouts/:id'],
      ['GET', '/api/checkouts/:id/messages/1'],
      ['POST', '/api/checkouts/:id/heartbeat', {}],
      ['POST', '/api/checkouts/:id/matching', { filter: [] }],
      ['POST', '/api/checkouts/:id/decisions', { handles: [1], decision: { kind: 'discard', reason: 'Not needed' } }],
      ['POST', '/api/checkouts/:id/apply', { confirm: true }],
      ['POST', '/api/checkouts/:id/end', {}],
      ['DELETE', '/api/checkouts/:id'],
    ];

    async function aliceAndBob() {
      await seedMessages('/', 'orders.dlq', 2);
      const a = new TestBrowser(baseUrl);
      const b = new TestBrowser(baseUrl);
      await a.signIn(alice);
      await b.signIn(bob);
      const started = await startCheckout(a, 'orders.dlq');
      expect(started.status).toBe(201);
      return { a, b, id: started.body.checkout.id as string };
    }

    it.each(routes)('refuses %s %s to anyone but its owner, without its contents', async (method, route, body) => {
      const { a, b, id } = await aliceAndBob();
      const res = await b.request(method, route.replace(':id', id), body === undefined ? {} : { body });
      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('not_checkout_owner');
      expect(JSON.stringify(res.body)).not.toMatch(/orders\.dlq|alice|payload|messages/i);

      // Bob changed nothing: Alice's Checkout is still active, holding both Messages without Decisions.
      const mine = await a.get(`/api/checkouts/${id}`);
      expect(mine.status).toBe(200);
      expect(mine.body.checkout).toMatchObject({ status: 'active', heldCount: 2 });
      expect(mine.body.checkout.messages.every((m: any) => m.decision.kind === 'keep')).toBe(true);
    });

    it('lets its owner use every route', async () => {
      const { a, id } = await aliceAndBob();
      const handle = (await a.get(`/api/checkouts/${id}`)).body.checkout.messages[0].handle;
      expect((await a.get(`/api/checkouts/${id}/messages/${handle}`)).status).toBe(200);
      expect((await a.post(`/api/checkouts/${id}/heartbeat`)).status).toBe(200);
      expect((await a.post(`/api/checkouts/${id}/matching`, { filter: [] })).status).toBe(200);
      expect((await a.post(`/api/checkouts/${id}/decisions`, { handles: [handle], decision: { kind: 'discard', reason: 'Not needed' } })).status).toBe(200);
      expect((await a.post(`/api/checkouts/${id}/end`)).status).toBe(200);
      expect((await a.request('DELETE', `/api/checkouts/${id}`)).status).toBe(200);
      expect(await readyCount('/', 'orders.dlq')).toBe(2);
    });

    it("records the signed-in Operator's identity and display name in the Audit Entry of an Apply", async () => {
      const { a, id } = await aliceAndBob();
      const handle = (await a.get(`/api/checkouts/${id}`)).body.checkout.messages[0].handle;
      await a.post(`/api/checkouts/${id}/decisions`, { handles: [handle], decision: { kind: 'discard', reason: 'Not needed' } });

      expect((await a.post(`/api/checkouts/${id}/apply`, { confirm: true })).status).toBe(200);

      const { entries } = (await a.get(`/api/audit-entries?checkoutId=${id}`)).body;
      expect(entries).toEqual([
        expect.objectContaining({ operatorId: alice.sub, operatorName: alice.email, action: 'discard', outcome: 'done' }),
      ]);
      expect(await readyCount('/', 'orders.dlq')).toBe(1);
    });
  });

  it('refuses a Checkout without a session', async () => {
    const res = await new TestBrowser(baseUrl).post(checkoutPath('orders.dlq'));
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('not_signed_in');
  });
});

describe('Team Mode startup', () => {
  it('fails with an explanatory message when the OIDC provider cannot be reached', async () => {
    const port = await closedPort();
    await expect(
      startTeamApp({ env: { VOLVERAN_OIDC_ISSUER: `http://127.0.0.1:${port}/default` } }),
    ).rejects.toThrow(/OIDC provider.*127\.0\.0\.1/s);
  });
});
