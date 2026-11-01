// What #125 keeps from a reader of the logs and from a client, how long an abandoned session
// lasts, and the session guard and sign-in limit reviewed with them in docs/threat-model.md.
import { mkdir, writeFile } from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AuditStore } from '../../src/server/audit/audit-store.js';
import { closedPort, makeTempDir, seedMessages, startApp, testProfile, withChannel, type StartAppOptions, type TestApp } from './harness.js';
import { teamModeEnv, TestBrowser, testOidc, testSessionEncryptionKey, testSessionSecret, type TestIdentity } from './oidc-provider.js';
import { startTwoReplicas, type TwoReplicas } from './two-replicas.js';

const ana: TestIdentity = { sub: 'ana-sub', email: 'ana@example.com', groups: ['ops'] };

async function startTeamApp(options: StartAppOptions = {}): Promise<TestApp> {
  const port = await closedPort();
  return startApp({ profiles: [testProfile({ name: 'dev' })], ...options, port, env: { ...teamModeEnv(`http://127.0.0.1:${port}`), ...options.env } });
}

const QUEUE = 'logs-errors-idle.dlq';
const checkouts = `/api/profiles/dev/vhosts/%2F/queues/${QUEUE}/checkouts`;

async function freshQueue(messages: number): Promise<void> {
  await withChannel('/', async (ch) => {
    await ch.deleteQueue(QUEUE);
    await ch.assertQueue(QUEUE, { durable: true });
  });
  await seedMessages('/', QUEUE, messages);
}

afterAll(async () => {
  await withChannel('/', (ch) => ch.deleteQueue(QUEUE));
});

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** A request exactly as written: fetch would tidy the path up first. */
function rawRequest(baseUrl: string, method: string, target: string, init: { headers?: Record<string, string>; body?: string } = {}): Promise<{ status: number; body: any }> {
  const { hostname, port } = new URL(baseUrl);
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname, port, method, path: target, headers: init.headers }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (chunk: string) => (text += chunk));
      res.on('end', () => {
        let body: unknown = text;
        try {
          body = JSON.parse(text);
        } catch {
          // not JSON
        }
        resolve({ status: res.statusCode!, body });
      });
    });
    req.on('error', reject);
    req.end(init.body);
  });
}

const cookieHeader = (browser: TestBrowser) => [...browser.cookies].map(([k, v]) => `${k}=${v}`).join('; ');

/** A store whose given session method fails as a database that has gone away does. */
function failingSessions(message: string, method: keyof AuditStore['sessions']): (store: AuditStore) => AuditStore {
  return (store) =>
    new Proxy(store, {
      get(target, property) {
        const value = Reflect.get(target, property, target) as unknown;
        if (property !== 'sessions') return typeof value === 'function' ? (value as (...a: unknown[]) => unknown).bind(target) : value;
        return new Proxy(target.sessions, {
          get(sessions, name) {
            if (name === method) return () => Promise.reject(new Error(message));
            return (Reflect.get(sessions, name, sessions) as (...a: unknown[]) => unknown).bind(sessions);
          },
        });
      },
    });
}

describe('what reaches the logs', () => {
  it('keeps codes, state, tokens, secrets and connection strings out of them, through a whole sign-in', async () => {
    const logs: Array<Record<string, any>> = [];
    const app = await startTeamApp({ logs });
    try {
      const browser = new TestBrowser(app.baseUrl);
      const callback = new URL(await browser.approveAtProvider(await browser.startSignIn('/somewhere'), ana));
      const code = callback.searchParams.get('code')!;
      const state = callback.searchParams.get('state')!;
      expect((await browser.get(callback.pathname + callback.search)).status).toBe(302);
      expect((await browser.get('/api/session')).status).toBe(200);
      const sessionCookie = browser.cookies.get('volveran_session')!;

      // One refused too: its code may still be live at the provider.
      const refused = new TestBrowser(app.baseUrl);
      const liveCallback = new URL(await refused.approveAtProvider(await refused.startSignIn(), ana));
      const liveCode = liveCallback.searchParams.get('code')!;
      liveCallback.searchParams.set('state', 'forged-state');
      expect((await refused.get(liveCallback.pathname + liveCallback.search)).status).toBe(400);

      const written = logs.map((line) => JSON.stringify(line)).join('\n');
      // The lines are there, and the path with them, so what follows is not true of an empty log.
      expect(logs.some((line) => line.req?.url === '/auth/callback')).toBe(true);
      for (const secret of [code, state, liveCode, 'forged-state', sessionCookie, decodeURIComponent(sessionCookie), testOidc.clientSecret, testSessionSecret, testSessionEncryptionKey]) {
        expect(written).not.toContain(secret);
      }
      expect(written).not.toMatch(/eyJ[\w-]+\.[\w-]+/); // any JWT: ID, access or refresh token
      expect(written).not.toMatch(/postgres(ql)?:\/\//);
    } finally {
      await app.close();
    }
  });

  it('keeps the query out of every request line, whichever way the path is spelt', async () => {
    const logs: Array<Record<string, any>> = [];
    const app = await startTeamApp({ logs });
    try {
      await rawRequest(app.baseUrl, 'GET', '/%61uth/callback?code=spelt-code&state=spelt-state');
      await rawRequest(app.baseUrl, 'GET', '/%zz?code=bad-url-code');
      const written = logs.map((line) => JSON.stringify(line)).join('\n');
      expect(written).not.toMatch(/spelt-code|spelt-state|bad-url-code/);
    } finally {
      await app.close();
    }
  });
});

describe('what errors tell a client', () => {
  it('answers an unhandled error generically, and logs the detail', async () => {
    const logs: Array<Record<string, any>> = [];
    const detail = 'connect ECONNREFUSED 10.1.2.3:5432';
    const app = await startTeamApp({ logs, wrapAuditStore: failingSessions(detail, 'addSignIn') });
    try {
      const res = await new TestBrowser(app.baseUrl).get('/auth/login');
      expect(res.status).toBe(500);
      expect(res.body).toEqual({ error: { code: 'internal_error', message: 'Something went wrong on the server. The details are in its log.' } });
      expect(JSON.stringify(logs)).toContain(detail);
    } finally {
      await app.close();
    }
  });

  it('does not tell a client what went wrong between Volverán and the provider', async () => {
    const logs: Array<Record<string, any>> = [];
    const app = await startTeamApp({ logs });
    try {
      const browser = new TestBrowser(app.baseUrl);
      const callback = new URL(await browser.approveAtProvider(await browser.startSignIn(), ana));
      callback.searchParams.set('state', 'forged-state');
      const res = await browser.get(callback.pathname + callback.search);
      expect(res.status).toBe(400);
      expect(res.body.error).toMatchObject({ code: 'sign_in_failed', message: "Sign-in failed: the provider's answer could not be used. Sign in again.", signInUrl: '/auth/login' });
      expect(logs.some((line) => line.level === 40 && /state/.test(line.reason ?? ''))).toBe(true);
    } finally {
      await app.close();
    }
  });

  describe('for a request it cannot take', () => {
    let app: TestApp;
    const route = '/api/profiles/dev/vhosts/%2F/queues/nothing/checkouts';
    beforeAll(async () => {
      const webRoot = await makeTempDir('web-root');
      await mkdir(webRoot, { recursive: true });
      await writeFile(path.join(webRoot, 'index.html'), '<!doctype html>');
      app = await startApp({ profiles: [testProfile({ name: 'dev' })], webRoot });
    });
    afterAll(async () => {
      await app?.close();
    });

    it.each([
      ['malformed JSON', { headers: { 'content-type': 'application/json' }, body: '{"secret-from-body' }, 400, 'invalid_request'],
      ['empty JSON', { headers: { 'content-type': 'application/json' } }, 400, 'invalid_request'],
      ['a body over the limit', { headers: { 'content-type': 'application/json' }, body: JSON.stringify({ a: 'x'.repeat(1_100_000) }) }, 413, 'body_too_large'],
      ['an unsupported media type', { headers: { 'content-type': 'application/xml' }, body: '<a/>' }, 415, 'unsupported_media_type'],
    ] as const)('keeps the status of %s', async (_what, init, status, code) => {
      const res = await rawRequest(app.baseUrl, 'POST', route, init);
      expect(res.status).toBe(status);
      expect(res.body.error.code).toBe(code);
      expect(res.body.error.message).not.toContain('secret-from-body');
    });

    it('keeps the status of a Forbidden from the static files', async () => {
      const res = await rawRequest(app.baseUrl, 'GET', '/%2e%2e/%2e%2e/etc/passwd');
      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('forbidden');
    });

    it('does not answer 500 to a doubled slash', async () => {
      const res = await rawRequest(app.baseUrl, 'GET', '//api/session');
      expect(res.status).toBeLessThan(500);
    });
  });
});

describe('the session guard', () => {
  let replicas: TwoReplicas;
  beforeAll(async () => {
    replicas = await startTwoReplicas({ profiles: [testProfile({ name: 'dev' })] });
  });
  afterAll(async () => {
    await replicas?.close();
  });

  it('refuses an encoded /api/ path without a session', async () => {
    const res = await rawRequest(replicas.a.baseUrl, 'GET', '/%61pi/session');
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('not_signed_in');
  });

  it('still refuses an /api/ path no route has, without a session', async () => {
    const res = await rawRequest(replicas.a.baseUrl, 'GET', '/api/no-such-route');
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('not_signed_in');
  });

  it('serves an encoded /api/ path to its Operator', async () => {
    const browser = replicas.browser();
    await browser.signIn(ana);
    const res = await rawRequest(replicas.a.baseUrl, 'GET', '/%61pi/session', { headers: { cookie: cookieHeader(browser) } });
    expect(res.status).toBe(200);
    expect(res.body.operatorId).toBe('ana-sub');
  });

  it("does not tell a Checkout's id from an unknown one on an encoded path, and never answers 500", async () => {
    await freshQueue(1);
    const owner = replicas.browser();
    await owner.signIn(ana);
    const started = await owner.to(replicas.a).request('POST', checkouts, { body: {} });
    expect(started.status).toBe(201);
    const id = started.body.checkout.id as string;
    try {
      for (const target of [id, '00000000-0000-4000-8000-000000000000']) {
        const res = await rawRequest(replicas.b.baseUrl, 'GET', `/%61pi/checkouts/${target}`);
        expect(res.status).toBe(401);
        expect(res.body.error.code).toBe('not_signed_in');
      }
      for (const replica of [replicas.a, replicas.b]) {
        const res = await rawRequest(replica.baseUrl, 'GET', `/%61pi/checkouts/${id}`, { headers: { cookie: cookieHeader(owner) } });
        expect(res.status).toBeLessThan(500);
      }
    } finally {
      await owner.to(replicas.a).request('DELETE', `/api/checkouts/${id}`);
    }
  });
});

describe('the session idle timeout', () => {
  const idleMs = 1_000;
  let app: TestApp;
  beforeAll(async () => {
    app = await startTeamApp({ sessionIdleMs: idleMs });
  });
  afterAll(async () => {
    await app?.close();
  });

  it('ends a session nobody uses, well before its lifetime', async () => {
    const browser = new TestBrowser(app.baseUrl);
    await browser.signIn(ana);
    expect((await browser.get('/api/session')).status).toBe(200);
    await sleep(idleMs + 300);
    const res = await browser.get('/api/session');
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('not_signed_in');
  });

  it('keeps a session in use for longer than the timeout', async () => {
    const browser = new TestBrowser(app.baseUrl);
    await browser.signIn(ana);
    for (let i = 0; i < 6; i++) {
      await sleep(idleMs / 3);
      expect((await browser.get('/api/session')).status).toBe(200);
    }
  });

  it("does not count what a page does on its own as the Operator's activity", async () => {
    const browser = new TestBrowser(app.baseUrl);
    await browser.signIn(ana);
    const polling = { headers: { 'x-volveran-background': '1' } };
    const started = Date.now();
    while (Date.now() - started < idleMs - 300) {
      expect((await browser.request('GET', '/api/session', polling)).status).toBe(200);
      await sleep(idleMs / 5);
    }
    await sleep(500);
    expect((await browser.request('GET', '/api/session', polling)).status).toBe(401);
  });

  it('refuses a timeout out of range at startup, naming the variable', async () => {
    await expect(startTeamApp({ env: { VOLVERAN_SESSION_IDLE_MINUTES: '0' } })).rejects.toThrow(/VOLVERAN_SESSION_IDLE_MINUTES/);
  });
});

describe('the session idle timeout with two Replicas', () => {
  const idleMs = 2_000;
  let replicas: TwoReplicas;
  beforeAll(async () => {
    replicas = await startTwoReplicas({ profiles: [testProfile({ name: 'dev' })], sessionIdleMs: idleMs });
  });
  afterAll(async () => {
    await replicas?.close();
  });

  it('counts a request forwarded to the Owner Replica, on the Replica that took it, and ends the session on both', async () => {
    await freshQueue(1);
    const browser = replicas.browser();
    await browser.signIn(ana);
    const started = await browser.to(replicas.a).request('POST', checkouts, { body: {} });
    expect(started.status).toBe(201);
    const id = started.body.checkout.id as string;
    // Replica b never owns this Checkout: everything here is forwarded to a.
    for (let i = 0; i < 6; i++) {
      await sleep(idleMs / 3);
      expect((await browser.to(replicas.b).request('POST', `/api/checkouts/${id}/heartbeat`)).status).toBe(200);
    }
    expect((await browser.to(replicas.a).get('/api/session')).status).toBe(200);
    await browser.to(replicas.a).request('DELETE', `/api/checkouts/${id}`);
    await sleep(idleMs + 500);
    expect((await browser.to(replicas.a).get('/api/session')).status).toBe(401);
    expect((await browser.to(replicas.b).get('/api/session')).status).toBe(401);
  });
});

describe('sign-ins in progress', () => {
  it('holds a limited number, so a flood drops the oldest and sign-in still works', async () => {
    const app = await startTeamApp({ maxSignInsInProgress: 3 });
    try {
      const oldest = new TestBrowser(app.baseUrl);
      const oldestCallback = await oldest.approveAtProvider(await oldest.startSignIn(), ana);
      await sleep(5); // expiry is to the millisecond: this one is the oldest
      for (let i = 0; i < 3; i++) {
        await new TestBrowser(app.baseUrl).startSignIn();
        await sleep(5);
      }
      const refused = await oldest.get(oldestCallback);
      expect(refused.status).toBe(400);
      expect(refused.body.error.code).toBe('sign_in_failed');

      const newest = new TestBrowser(app.baseUrl);
      expect((await newest.signIn(ana)).status).toBe(302);
      expect((await newest.get('/api/session')).status).toBe(200);
    } finally {
      await app.close();
    }
  });
});
