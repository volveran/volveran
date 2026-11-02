// What a malicious page can send through an Operator's browser (#123). In Team Mode a
// state-changing request from a foreign Origin is refused, on top of SameSite=Lax. In Solo
// Mode, which has no credential but the loopback address, so is any request with a foreign
// Host (DNS rebinding) or Origin. API scripts send no Origin and keep working.
import http from 'node:http';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { closedPort, purgeQueues, readyCount, seedMessages, startApp, testProfile, withChannel, type TestApp } from './harness.js';
import { teamModeEnv, TestBrowser } from './oidc-provider.js';
import { startTwoReplicas, type TwoReplicas } from './two-replicas.js';

const QUEUE = 'origin-and-host.dlq';
const startPath = `/api/profiles/dev/vhosts/%2F/queues/${QUEUE}/checkouts`;
const ana = { sub: 'ana-sub', email: 'ana@example.com' };

/** A request with exactly these headers: fetch will not send a Host of our choosing. */
function send(baseUrl: string, method: string, path: string, headers: Record<string, string>): Promise<{ status: number; body: any }> {
  const { hostname, port } = new URL(baseUrl);
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname, port, method, path, headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString();
        let body: unknown = text;
        try {
          body = JSON.parse(text);
        } catch {
          // not JSON
        }
        resolve({ status: res.statusCode ?? 0, body });
      });
    });
    req.on('error', reject);
    req.end();
  });
}

beforeEach(async () => {
  await withChannel('/', async (ch) => {
    await ch.assertQueue(QUEUE, { durable: true });
  });
  await purgeQueues('/', [QUEUE]);
});

describe('Solo Mode', () => {
  let app: TestApp;
  let self: string;
  beforeAll(async () => {
    app = await startApp({ profiles: [testProfile({ name: 'dev' })] });
    self = new URL(app.baseUrl).host;
  });
  afterAll(async () => {
    await app?.close();
  });

  it.each(['evil.example', 'evil.example:8080', 'localhost.evil.example', '127.0.0.1.nip.io', 'user@localhost'])(
    'refuses a request with Host %s, reads as well as changes',
    async (host) => {
      for (const [method, path] of [['GET', '/api/profiles'], ['GET', '/healthz'], ['GET', '/'], ['POST', startPath]] as const) {
        const res = await send(app.baseUrl, method, path, { host });
        expect(res.status).toBe(403);
        expect(res.body.error.code).toBe('foreign_host');
      }
    },
  );

  it('takes nothing off the queue for what a DNS-rebinding page sends', async () => {
    await seedMessages('/', QUEUE, 2);
    const res = await send(app.baseUrl, 'POST', startPath, { host: 'evil.example', origin: 'http://evil.example' });
    expect(res.status).toBe(403);
    expect(await readyCount('/', QUEUE)).toBe(2);
  });

  it.each(['http://evil.example', 'http://localhost:1', 'http://127.0.0.1:1', 'null', 'http://a, http://b'])(
    'refuses Origin %s under a Host of its own',
    async (origin) => {
      await seedMessages('/', QUEUE, 1);
      for (const [method, path] of [['GET', '/api/profiles'], ['POST', startPath]] as const) {
        const res = await send(app.baseUrl, method, path, { host: self, origin });
        expect(res.status).toBe(403);
        expect(res.body.error.code).toBe('foreign_origin');
      }
      expect(await readyCount('/', QUEUE)).toBe(1);
    },
  );

  it('answers at any loopback name, as a browser or a tunnel reaches it', async () => {
    const { port } = new URL(app.baseUrl);
    for (const host of [self, `localhost:${port}`, `LOCALHOST:${port}`, `[::1]:${port}`, 'localhost:9000']) {
      expect((await send(app.baseUrl, 'GET', '/api/profiles', { host })).status).toBe(200);
    }
  });

  it('takes a page of its own, and a script with no Origin', async () => {
    const { port } = new URL(app.baseUrl);
    for (const [host, origin] of [[self, `http://${self}`], [`localhost:${port}`, `http://localhost:${port}`], ['localhost:5173', 'http://localhost:5173']] as const) {
      expect((await send(app.baseUrl, 'GET', '/api/profiles', { host, origin })).status).toBe(200);
    }
    await seedMessages('/', QUEUE, 1);
    const started = await app.post(startPath);
    expect(started.status).toBe(201);
    expect((await app.post(`/api/checkouts/${started.body.checkout.id}/end`)).status).toBe(200);
  });
});

describe('Solo Mode behind a name of its own', () => {
  let app: TestApp | undefined;
  afterEach(async () => {
    await app?.close();
  });

  it('takes the Host and Origin of VOLVERAN_PUBLIC_URL', async () => {
    app = await startApp({ profiles: [testProfile({ name: 'dev' })], env: { VOLVERAN_PUBLIC_URL: 'https://volveran.example/base' } });
    const named = { host: 'volveran.example', origin: 'https://volveran.example' };
    expect((await send(app.baseUrl, 'GET', '/api/profiles', named)).status).toBe(200);
    // A proxy in front that sets the Host to where it connects.
    expect((await send(app.baseUrl, 'GET', '/api/profiles', { host: new URL(app.baseUrl).host, origin: named.origin })).status).toBe(200);
    expect((await send(app.baseUrl, 'GET', '/api/profiles', { host: 'other.example' })).body.error.code).toBe('foreign_host');
    expect((await send(app.baseUrl, 'GET', '/api/profiles', { host: 'volveran.example', origin: 'https://other.example' })).body.error.code).toBe('foreign_origin');
  });
});

describe('the metrics port in Solo Mode', () => {
  let app: TestApp | undefined;
  afterEach(async () => {
    await app?.close();
  });

  it('refuses a foreign Host, and serves a scrape at a loopback one', async () => {
    app = await startApp({ profiles: [testProfile({ name: 'dev' })], env: { VOLVERAN_METRICS_PORT: String(await closedPort()) } });
    const metrics = new URL(app.metricsUrl!);
    expect((await send(metrics.origin, 'GET', metrics.pathname, { host: 'evil.example' })).status).toBe(403);
    expect((await send(metrics.origin, 'GET', metrics.pathname, { host: metrics.host })).status).toBe(200);
  });
});

describe('Team Mode', () => {
  let app: TestApp;
  let baseUrl: string;
  let browser: TestBrowser;
  const publicUrl = 'https://volveran.example';

  beforeAll(async () => {
    const port = await closedPort();
    baseUrl = `http://127.0.0.1:${port}`;
    app = await startApp({
      profiles: [testProfile({ name: 'dev' })],
      port,
      env: { ...teamModeEnv(baseUrl), VOLVERAN_PUBLIC_URL: `${publicUrl}/volveran` },
    });
    browser = new TestBrowser(baseUrl);
    await browser.signIn(ana);
  });
  afterAll(async () => {
    await app?.close();
  });

  it.each(['https://evil.example', 'https://sub.volveran.example', 'http://volveran.example', 'null'])(
    'refuses a Checkout started from Origin %s, with the session cookie',
    async (origin) => {
      await seedMessages('/', QUEUE, 1);
      const res = await browser.request('POST', startPath, { headers: { origin } });
      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('foreign_origin');
      expect(await readyCount('/', QUEUE)).toBe(1);
    },
  );

  it.each(['POST', 'PUT', 'PATCH', 'DELETE'])('refuses %s from a foreign Origin, whichever the route', async (method) => {
    const res = await browser.request(method, '/api/session', { headers: { origin: 'https://evil.example' } });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('foreign_origin');
  });

  it('does not sign out for a foreign Origin', async () => {
    const res = await browser.request('POST', '/auth/logout', { headers: { origin: 'https://evil.example' } });
    expect(res.status).toBe(403);
    expect((await browser.get('/api/session')).status).toBe(200);
  });

  it('still answers a read from another Origin, which CORS keeps from the page', async () => {
    expect((await browser.request('GET', '/api/session', { headers: { origin: 'https://evil.example' } })).status).toBe(200);
  });

  it('takes the web app at the redirect URL, at VOLVERAN_PUBLIC_URL, and a script with no Origin', async () => {
    for (const headers of [{ origin: baseUrl }, { origin: publicUrl }, {}] as Array<Record<string, string>>) {
      await seedMessages('/', QUEUE, 1);
      const started = await browser.request('POST', startPath, { headers });
      expect(started.status).toBe(201);
      expect((await browser.request('POST', `/api/checkouts/${started.body.checkout.id}/end`, { headers })).status).toBe(200);
      await purgeQueues('/', [QUEUE]);
    }
  });

  it('looks at no Host, which a proxy may change', async () => {
    const res = await send(baseUrl, 'GET', '/healthz', { host: 'internal.proxy.example' });
    expect(res.status).toBe(200);
  });

  it('signs out from the web app', async () => {
    const leaving = new TestBrowser(baseUrl);
    await leaving.signIn(ana);
    expect((await leaving.request('POST', '/auth/logout', { headers: { origin: baseUrl } })).status).toBe(204);
    expect((await leaving.get('/api/session')).status).toBe(401);
  });
});

describe('forwarded requests', () => {
  let replicas: TwoReplicas;
  const publicOrigin = 'https://volveran.example';

  beforeAll(async () => {
    replicas = await startTwoReplicas({ profiles: [testProfile({ name: 'dev' })], env: { VOLVERAN_PUBLIC_URL: publicOrigin } });
  });
  afterAll(async () => {
    await replicas?.close();
  });

  it('keep working from the web app, with the owner seeing another Host, and a foreign Origin is refused', async () => {
    const browser = replicas.browser();
    await browser.signIn(ana);
    await seedMessages('/', QUEUE, 1);
    const started = await browser.to(replicas.a).post(startPath);
    expect(started.status).toBe(201);
    const id: string = started.body.checkout.id;
    const through = browser.to(replicas.b);

    const beat = await through.request('POST', `/api/checkouts/${id}/heartbeat`, { headers: { origin: publicOrigin }, body: {} });
    expect(beat.status).toBe(200);
    expect(beat.body.checkout.id).toBe(id);

    const refused = await through.request('POST', `/api/checkouts/${id}/heartbeat`, { headers: { origin: 'https://evil.example' }, body: {} });
    expect(refused.status).toBe(403);
    expect(refused.body.error.code).toBe('foreign_origin');

    expect((await through.request('POST', `/api/checkouts/${id}/end`, { headers: { origin: publicOrigin }, body: {} })).status).toBe(200);
  });
});
