// The security headers a browser gets from Volverán (#124), on every answer of the web port:
// its own routes, static files, and the answers Fastify writes without running any hook.
import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { build } from 'vite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closedPort, makeTempDir, purgeQueues, seedMessages, startApp, testProfile, withChannel, type TestApp } from './harness.js';
import { teamModeEnv, TestBrowser } from './oidc-provider.js';
import { startTwoReplicas, type TwoReplicas } from './two-replicas.js';

const CSP = "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'";
const HSTS = 'max-age=31536000';

function expectBrowserHeaders(res: Response, label: string): void {
  expect(res.headers.get('content-security-policy'), label).toBe(CSP);
  expect(res.headers.get('x-content-type-options'), label).toBe('nosniff');
  expect(res.headers.get('x-frame-options'), label).toBe('DENY');
  expect(res.headers.get('referrer-policy'), label).toBe('no-referrer');
}

describe('security headers', () => {
  let webRoot: string;
  let app: TestApp;
  beforeAll(async () => {
    webRoot = await makeTempDir('security-headers-web');
    await mkdir(path.join(webRoot, 'assets'));
    await writeFile(path.join(webRoot, 'index.html'), '<!doctype html><title>built</title>');
    await writeFile(path.join(webRoot, 'assets', 'index.js'), 'export {};');
    app = await startApp({ profiles: [testProfile({ name: 'local' })], webRoot });
  });
  afterAll(async () => {
    await app?.close();
    await rm(webRoot, { recursive: true, force: true });
  });

  it.each([
    ['the web app', '/', 200],
    ['a static file', '/assets/index.js', 200],
    ['a path the not-found handler answers with the web app', '/some/view', 200],
    ['an API answer', '/api/session', 200],
    ['an unknown API path', '/api/nothing-here', 404],
    ['a probe', '/healthz', 200],
    ['an error from a route', '/api/checkouts/no-such-checkout', 404],
    ['a URL Fastify refuses before any hook runs', '/%E0%A4%A', 400],
  ])('are on %s', async (label, urlPath, status) => {
    const res = await fetch(app.baseUrl + urlPath);
    expect(res.status, label).toBe(status);
    expectBrowserHeaders(res, label);
  });

  it('keep API answers, which carry Message bodies, out of the browser cache, but not the web app', async () => {
    expect((await fetch(`${app.baseUrl}/api/session`)).headers.get('cache-control')).toBe('no-store');
    expect((await fetch(`${app.baseUrl}/api/checkouts/no-such-checkout`)).headers.get('cache-control')).toBe('no-store');
    expect((await fetch(`${app.baseUrl}/`)).headers.get('cache-control')).not.toContain('no-store');
    expect((await fetch(`${app.baseUrl}/assets/index.js`)).headers.get('cache-control')).not.toContain('no-store');
  });

  it('are on the answers of the metrics port, whose labels carry queue names', async () => {
    const withMetrics = await startApp({ profiles: [testProfile({ name: 'local' })], env: { VOLVERAN_METRICS_PORT: String(await closedPort()) } });
    try {
      const scrape = await fetch(withMetrics.metricsUrl!);
      expect(scrape.status).toBe(200);
      expectBrowserHeaders(scrape, 'a scrape');
      const elsewhere = await fetch(new URL('/other', withMetrics.metricsUrl!));
      expect(elsewhere.status).toBe(404);
      expectBrowserHeaders(elsewhere, 'another path');
    } finally {
      await withMetrics.close();
    }
  });

  describe('HSTS', () => {
    const hstsOf = async (base: string, headers: Record<string, string>) => (await fetch(`${base}/api/session`, { headers })).headers.get('strict-transport-security');

    it('is sent when the proxy in front says the request came over https', async () => {
      expect(await hstsOf(app.baseUrl, { 'x-forwarded-proto': 'https' })).toBe(HSTS);
      expect(await hstsOf(app.baseUrl, { 'x-forwarded-proto': 'https,http' })).toBe(HSTS);
    });

    it('is not sent over plain http', async () => {
      expect(await hstsOf(app.baseUrl, {})).toBeNull();
      expect(await hstsOf(app.baseUrl, { 'x-forwarded-proto': 'http' })).toBeNull();
    });

    it('is sent when Volverán is reached from outside over https, even from a proxy that does not say so', async () => {
      const behindProxy = await startApp({ profiles: [testProfile({ name: 'local' })], env: { VOLVERAN_PUBLIC_URL: 'https://volveran.example.com' } });
      try {
        expect(await hstsOf(behindProxy.baseUrl, {})).toBe(HSTS);
      } finally {
        await behindProxy.close();
      }
    });
  });
});

describe('security headers in Team Mode', () => {
  let app: TestApp;
  beforeAll(async () => {
    const port = await closedPort();
    app = await startApp({ profiles: [testProfile({ name: 'local' })], port, env: teamModeEnv(`http://127.0.0.1:${port}`) });
  });
  afterAll(async () => {
    await app?.close();
  });

  it.each([
    ['the start of a sign-in', '/auth/login', 302],
    ['a refusal without a session', '/api/session', 401],
  ])('are on %s, which is kept out of the browser cache', async (label, urlPath, status) => {
    const res = await fetch(app.baseUrl + urlPath, { redirect: 'manual' });
    expect(res.status, label).toBe(status);
    expectBrowserHeaders(res, label);
    expect(res.headers.get('cache-control'), label).toBe('no-store');
  });

  it('let a signed-in Operator keep working', async () => {
    const browser = new TestBrowser(app.baseUrl);
    await browser.signIn({ sub: 'ana' });
    expect((await browser.get('/api/session')).status).toBe(200);
  });
});

describe('security headers through another Replica', () => {
  const QUEUE = 'security-headers.dlq';
  let replicas: TwoReplicas;
  beforeAll(async () => {
    await withChannel('/', async (ch) => {
      await ch.assertQueue(QUEUE, { durable: true });
    });
    await purgeQueues('/', [QUEUE]);
    await seedMessages('/', QUEUE, 1);
    replicas = await startTwoReplicas({ profiles: [testProfile({ name: 'dev' })] });
  });
  afterAll(async () => {
    await replicas?.close();
    await withChannel('/', async (ch) => {
      await ch.deleteQueue(QUEUE);
    });
  });

  it('are on a forwarded answer, once each, with HSTS decided by the Replica the browser reached', async () => {
    const browser = replicas.browser();
    await browser.signIn({ sub: 'ana' });
    const started = await browser.to(replicas.a).post(`/api/profiles/dev/vhosts/%2F/queues/${QUEUE}/checkouts`, {});
    expect(started.status).toBe(201);
    const { id } = started.body.checkout;
    const cookie = [...browser.cookies].map(([name, value]) => `${name}=${value}`).join('; ');

    const res = await fetch(`${replicas.b.baseUrl}/api/checkouts/${id}`, { headers: { cookie, 'x-forwarded-proto': 'https' } });
    expect(res.status).toBe(200);
    expect((await res.json()).checkout.id).toBe(id);
    expectBrowserHeaders(res, 'forwarded');
    expect(res.headers.get('strict-transport-security')).toBe(HSTS);
    expect(res.headers.get('cache-control')).toBe('no-store');

    expect((await browser.to(replicas.a).post(`/api/checkouts/${id}/end`)).status).toBe(200);
  });
});

// The built web app against the policy the server sends. It stops short of a browser: it reads
// what the page asks for and what the policy allows, and cannot see what the page does at runtime.
describe('the built web app under the Content-Security-Policy', () => {
  let outDir: string;
  let app: TestApp;
  let page: string;
  let css: string;
  let script: string;

  const fetchFrom = async (urlPath: string) => {
    const res = await fetch(app.baseUrl + urlPath);
    expect(res.status, urlPath).toBe(200);
    expectBrowserHeaders(res, urlPath);
    return res;
  };

  beforeAll(async () => {
    outDir = await makeTempDir('security-headers-build');
    await build({ configFile: path.join(import.meta.dirname, '../../vite.config.ts'), logLevel: 'silent', build: { outDir, emptyOutDir: true } });
    app = await startApp({ profiles: [testProfile({ name: 'local' })], webRoot: outDir });
    page = await (await fetchFrom('/')).text();
    const scriptPath = /<script[^>]* src="([^"]+)"/.exec(page)![1]!;
    const cssPath = /<link[^>]* rel="stylesheet"[^>]* href="([^"]+)"/.exec(page)![1]!;
    // With nosniff, a browser refuses a script or style served under any other type.
    const scriptAnswer = await fetchFrom(scriptPath);
    expect(scriptAnswer.headers.get('content-type')).toMatch(/javascript/);
    script = await scriptAnswer.text();
    const cssAnswer = await fetchFrom(cssPath);
    expect(cssAnswer.headers.get('content-type')).toMatch(/^text\/css/);
    css = await cssAnswer.text();
  });
  afterAll(async () => {
    await app?.close();
    await rm(outDir, { recursive: true, force: true });
  });

  it('asks only for its own files: nothing inline and no other host', () => {
    expect(page).not.toMatch(/<style/i);
    expect(page).not.toMatch(/\son\w+=/i);
    expect(page).not.toMatch(/\sstyle=/i);
    for (const [tag] of page.matchAll(/<script[^>]*>/gi)) expect(tag).toMatch(/ src="\/assets\//);
    for (const [tag] of page.matchAll(/<link[^>]*>/gi)) expect(tag).toMatch(/ href="\/assets\//);
    expect(page).not.toMatch(/https?:\/\//);
  });

  it('loads every font from itself, and uses data: only for images', async () => {
    const urls = [...css.matchAll(/url\(\s*["']?([^"')]+)/g)].map((m) => m[1]!).filter((u) => !u.startsWith('#'));
    const fonts = urls.filter((u) => /\.woff2$/.test(u));
    expect(fonts.length).toBeGreaterThan(0);
    for (const font of fonts) {
      expect(font).toMatch(/^\/assets\//);
      await fetchFrom(font);
    }
    expect(urls.filter((u) => !fonts.includes(u)).every((u) => u.startsWith('data:image/'))).toBe(true);
    expect(css).not.toMatch(/@import/);
  });

  it('runs no code from a string, which script-src would refuse', () => {
    expect(script).not.toMatch(/\beval\(|new Function\b/);
  });
});
