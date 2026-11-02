// The API under /api/v1, and /api as its alias through 1.x (#129): what stands in front of a
// handler answers the same under both. Every role check is in authorization-matrix.test.ts.
import http from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closedPort, eventually, purgeQueues, readyCount, seedMessages, startApp, testProfile, withChannel, type TestApp } from './harness.js';
import { teamModeEnv, TestBrowser } from './oidc-provider.js';

const QUEUE = 'api-v1.dlq';
const PREFIXES = ['/api', '/api/v1'];
const ana = { sub: 'ana-sub', email: 'ana@example.com', groups: ['ops'] };
const ben = { sub: 'ben-sub', email: 'ben@example.com', groups: ['ops'] };

/** A request with exactly these headers: fetch will not send a Host of our choosing. */
function send(baseUrl: string, method: string, path: string, headers: Record<string, string>): Promise<{ status: number; code: string | undefined }> {
  const { hostname, port } = new URL(baseUrl);
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname, port, method, path, headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, code: JSON.parse(Buffer.concat(chunks).toString()).error?.code }));
    });
    req.on('error', reject);
    req.end();
  });
}

describe.each(PREFIXES)('%s in Team Mode', (prefix) => {
  let app: TestApp;
  let baseUrl: string;
  let anaBrowser: TestBrowser;
  let benBrowser: TestBrowser;
  const startPath = `${prefix}/profiles/dev/vhosts/%2F/queues/${QUEUE}/checkouts`;

  beforeAll(async () => {
    await withChannel('/', (ch) => ch.assertQueue(QUEUE, { durable: true }));
    await purgeQueues('/', [QUEUE]);
    const port = await closedPort();
    baseUrl = `http://127.0.0.1:${port}`;
    app = await startApp({ profiles: [testProfile({ name: 'dev', roles: { operator: ['ops'] } })], port, env: teamModeEnv(baseUrl) });
    anaBrowser = new TestBrowser(baseUrl);
    await anaBrowser.signIn(ana);
    benBrowser = new TestBrowser(baseUrl);
    await benBrowser.signIn(ben);
  });

  afterAll(async () => {
    await app?.close();
    await withChannel('/', (ch) => ch.deleteQueue(QUEUE));
  });

  it("keeps another Operator out of a Checkout, and serves the owner's whole Checkout", async () => {
    await seedMessages('/', QUEUE, 2);
    const started = await anaBrowser.post(startPath);
    expect(started.status).toBe(201);
    const { id } = started.body.checkout;
    const handle = started.body.checkout.messages[0].handle;

    for (const [method, path] of [
      ['GET', `${prefix}/checkouts/${id}`],
      ['GET', `${prefix}/checkouts/${id}/messages/${handle}`],
      ['POST', `${prefix}/checkouts/${id}/heartbeat`],
      ['POST', `${prefix}/checkouts/${id}/end`],
      ['DELETE', `${prefix}/checkouts/${id}`],
    ] as const) {
      const refused = await benBrowser.request(method, path);
      expect(refused.status, `${method} ${path}`).toBe(403);
      expect(refused.body.error.code, `${method} ${path}`).toBe('not_checkout_owner');
    }

    expect((await anaBrowser.get(`${prefix}/checkouts/${id}`)).body.checkout.id).toBe(id);
    expect((await anaBrowser.get(`${prefix}/checkouts/${id}/messages/${handle}`)).status).toBe(200);
    // Started under one prefix, it goes on under the other: they are one API.
    const other = prefix === '/api' ? '/api/v1' : '/api';
    expect((await anaBrowser.post(`${other}/checkouts/${id}/heartbeat`)).status).toBe(200);
    expect((await anaBrowser.request('DELETE', `${prefix}/checkouts/${id}`)).status).toBe(200);
    await eventually(async () => expect(await readyCount('/', QUEUE)).toBe(2));
    await purgeQueues('/', [QUEUE]);
  });

  it('answers 401 without a session, also on a path no route has and under a percent-encoded path', async () => {
    const encoded = prefix.replace('/api', '/%61pi');
    for (const path of [`${prefix}/session`, `${prefix}/no-such-route`, `${encoded}/session`]) {
      const res = await new TestBrowser(baseUrl).get(path);
      expect(res.status, path).toBe(401);
      expect(res.body.error.code, path).toBe('not_signed_in');
    }
  });

  it('answers 404 not_found as JSON on a path no route has', async () => {
    const res = await anaBrowser.get(`${prefix}/no-such-route`);
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('not_found');
  });

  it('refuses a state-changing request from a foreign Origin, and lets its own through', async () => {
    const refused = await anaBrowser.request('POST', startPath, { headers: { origin: 'https://evil.example' } });
    expect(refused.status).toBe(403);
    expect(refused.body.error.code).toBe('foreign_origin');

    const own = await anaBrowser.request('POST', `${prefix}/checkouts/no-such-checkout/heartbeat`, { headers: { origin: baseUrl } });
    expect(own.body.error.code).toBe('checkout_not_found');
  });

  it('sends the security headers, on an answer and on a refusal', async () => {
    for (const path of [`${prefix}/session`, `${prefix}/no-such-route`]) {
      const res = await fetch(baseUrl + path);
      expect(res.headers.get('content-security-policy'), path).toContain("default-src 'none'");
      expect(res.headers.get('x-content-type-options'), path).toBe('nosniff');
      expect(res.headers.get('x-frame-options'), path).toBe('DENY');
      expect(res.headers.get('cache-control'), path).toBe('no-store');
    }
  });
});

describe.each(PREFIXES)('%s in Solo Mode', (prefix) => {
  let app: TestApp;

  beforeAll(async () => {
    app = await startApp({ profiles: [testProfile({ name: 'dev' })] });
  });

  afterAll(() => app?.close());

  it('answers at a loopback Host, and refuses a foreign Host or Origin', async () => {
    const { host } = new URL(app.baseUrl);
    expect((await send(app.baseUrl, 'GET', `${prefix}/session`, { host })).status).toBe(200);
    expect(await send(app.baseUrl, 'GET', `${prefix}/session`, { host: 'evil.example' })).toEqual({ status: 403, code: 'foreign_host' });
    expect(await send(app.baseUrl, 'GET', `${prefix}/session`, { host, origin: 'https://evil.example' })).toEqual({ status: 403, code: 'foreign_origin' });
  });
});
