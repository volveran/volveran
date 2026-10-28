// Team Mode test helpers: the mock OIDC provider of this checkout
// (test/broker/docker-compose.yml, service `oidc`) and a minimal browser that
// signs an Operator in through it with a cookie jar.
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { publishedPorts, repoRoot, testBrokerSettings } from '../../scripts/test-broker-env.mjs';

let port: number | undefined;
function oidcPort(): number {
  if (port === undefined) {
    const settings = testBrokerSettings(repoRoot, process.env);
    port = Number(settings.oidcPort ?? publishedPorts(settings.project).oidcPort);
  }
  return port;
}

export const testOidc = {
  get issuer() {
    return `http://127.0.0.1:${oidcPort()}/default`;
  },
  clientId: 'volveran-test',
  clientSecret: 'volveran-test-secret',
};

export const testSessionSecret = 'test-session-secret-0123456789abcdef';

/** The environment of a Team Mode app reached at `baseUrl` (startApp merges it over its defaults). */
export function teamModeEnv(baseUrl: string, issuer = testOidc.issuer): Record<string, string | undefined> {
  return {
    VOLVERAN_AUTH: 'oidc',
    VOLVERAN_OPERATOR: undefined,
    VOLVERAN_OIDC_ISSUER: issuer,
    VOLVERAN_OIDC_CLIENT_ID: testOidc.clientId,
    VOLVERAN_OIDC_CLIENT_SECRET: testOidc.clientSecret,
    VOLVERAN_OIDC_REDIRECT_URL: `${baseUrl}/auth/callback`,
    VOLVERAN_SESSION_SECRET: testSessionSecret,
  };
}

/** Who signs in at the mock provider: `sub` plus extra ID token claims. */
export interface TestIdentity {
  sub: string;
  email?: string;
  name?: string;
  /** The groups claim (VOLVERAN_OIDC_GROUPS_CLAIM, default `groups`), for Roles. */
  groups?: unknown;
  /** Any other ID token claim, e.g. `realm_access` for a dotted groups claim. */
  [claim: string]: unknown;
}

export interface BrowserResponse {
  status: number;
  location: string | null;
  setCookies: string[];
  body: any;
}

/**
 * A cookie-keeping HTTP client that never follows redirects, standing in for
 * the Operator's browser.
 */
export class TestBrowser {
  readonly cookies = new Map<string, string>();

  constructor(readonly baseUrl: string) {}

  async request(method: string, url: string, init: { body?: unknown; form?: Record<string, string> } = {}): Promise<BrowserResponse> {
    const absolute = new URL(url, this.baseUrl);
    const headers: Record<string, string> = {};
    if (absolute.origin === new URL(this.baseUrl).origin && this.cookies.size > 0) {
      headers.cookie = [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; ');
    }
    let body: string | undefined;
    if (init.form) {
      headers['content-type'] = 'application/x-www-form-urlencoded';
      body = new URLSearchParams(init.form).toString();
    } else if (init.body !== undefined) {
      headers['content-type'] = 'application/json';
      body = JSON.stringify(init.body);
    }
    const res = await fetch(absolute, { method, headers, body, redirect: 'manual' });
    const setCookies = res.headers.getSetCookie();
    if (absolute.origin === new URL(this.baseUrl).origin) {
      for (const c of setCookies) {
        const [pair = ''] = c.split(';');
        const eq = pair.indexOf('=');
        const name = pair.slice(0, eq).trim();
        const value = pair.slice(eq + 1).trim();
        if (value === '' || /expires=Thu, 01 Jan 1970/i.test(c) || /max-age=0/i.test(c)) this.cookies.delete(name);
        else this.cookies.set(name, value);
      }
    }
    const text = await res.text();
    let parsed: any = text;
    try {
      parsed = text ? JSON.parse(text) : undefined;
    } catch {
      // not JSON
    }
    return { status: res.status, location: res.headers.get('location'), setCookies, body: parsed };
  }

  get(url: string) {
    return this.request('GET', url);
  }

  post(url: string, body: unknown = {}) {
    return this.request('POST', url, { body });
  }

  /** Starts sign-in at Volverán and returns the provider's authorize URL. */
  async startSignIn(returnTo?: string): Promise<string> {
    const res = await this.get(returnTo ? `/auth/login?returnTo=${encodeURIComponent(returnTo)}` : '/auth/login');
    if (res.status !== 302 || !res.location) throw new Error(`/auth/login answered ${res.status}`);
    return res.location;
  }

  /** Signs in at the mock provider and returns the redirect back to Volverán (with code and state). */
  async approveAtProvider(authorizeUrl: string, identity: TestIdentity): Promise<string> {
    const { sub, ...claims } = identity;
    const res = await this.request('POST', authorizeUrl, { form: { username: sub, claims: JSON.stringify(claims) } });
    if (res.status !== 302 || !res.location) throw new Error(`the provider answered ${res.status}`);
    return res.location;
  }

  /** The whole sign-in round trip; returns Volverán's final response (a redirect into the app). */
  async signIn(identity: TestIdentity, returnTo?: string): Promise<BrowserResponse> {
    const callback = await this.approveAtProvider(await this.startSignIn(returnTo), identity);
    return this.get(callback);
  }
}

/** A running stand-in for a provider that keeps the groups out of the ID token. */
export interface UserinfoProvider {
  issuer: string;
  close(): Promise<void>;
}

/**
 * The mock provider behind an HTTP proxy whose userinfo endpoint answers with
 * `extraClaims(sub)` merged in, standing in for a provider that sends some
 * claims only from userinfo. The mock's issuer follows the Host header, so
 * discovery and tokens all name the proxy as the issuer.
 */
export async function startUserinfoProvider(extraClaims: (sub: string) => Record<string, unknown>): Promise<UserinfoProvider> {
  const upstream = new URL(testOidc.issuer);
  const server = http.createServer((req, res) => {
    const forward = http.request(
      { host: upstream.hostname, port: upstream.port, method: req.method, path: req.url, headers: req.headers },
      (answer) => {
        if (req.url?.split('?')[0] !== `${upstream.pathname}/userinfo` || answer.statusCode !== 200) {
          res.writeHead(answer.statusCode ?? 502, answer.headers);
          answer.pipe(res);
          return;
        }
        const chunks: Buffer[] = [];
        answer.on('data', (c: Buffer) => chunks.push(c));
        answer.on('end', () => {
          const claims = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ ...claims, ...extraClaims(claims.sub) }));
        });
      },
    );
    forward.on('error', (err) => res.destroy(err));
    req.pipe(forward);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    issuer: `http://127.0.0.1:${port}${upstream.pathname}`,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

/** A running stand-in for a provider with short-lived access tokens whose refresh can be refused. */
export interface ShortTokenProvider {
  issuer: string;
  /** Refresh grants answered since start (refused ones included). */
  refreshes(): number;
  /** From now on, answer every refresh grant 400 `invalid_grant`, as for a revoked or expired refresh token. */
  refuseRefreshes(): void;
  close(): Promise<void>;
}

/** The mock provider's signing key (test/broker/oidc.json), which the OAuth 2.0 test broker trusts. */
function mockSigningKey(): crypto.KeyObject {
  const config = JSON.parse(fs.readFileSync(path.join(repoRoot, 'test/broker/oidc.json'), 'utf8'));
  return crypto.createPrivateKey({ key: JSON.parse(config.tokenProvider.keyProvider.initialKeys), format: 'jwk' });
}

/** `token` with `exp` (and `iat`) set to `lifetimeSeconds` from now, signed again with `key`. */
function withLifetime(token: string, lifetimeSeconds: number, key: crypto.KeyObject): string {
  const [header = '', payload = ''] = token.split('.');
  const now = Math.floor(Date.now() / 1000);
  const claims = { ...JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')), iat: now, nbf: now, exp: now + lifetimeSeconds };
  const signed = `${header}.${Buffer.from(JSON.stringify(claims)).toString('base64url')}`;
  return `${signed}.${crypto.sign('RSA-SHA256', Buffer.from(signed), key).toString('base64url')}`;
}

/**
 * The mock provider behind an HTTP proxy that gives every access token a
 * lifetime of `lifetimeSeconds` from when it is issued, by sign-in or by
 * refresh (the mock's own refresh grant copies `exp`, so a refreshed token
 * would expire with the old one). It signs them again with the mock's key, so
 * the OAuth 2.0 test broker accepts them.
 */
export async function startShortTokenProvider(lifetimeSeconds: number): Promise<ShortTokenProvider> {
  const upstream = new URL(testOidc.issuer);
  const key = mockSigningKey();
  let refreshes = 0;
  let refusing = false;
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      const isToken = req.method === 'POST' && req.url?.split('?')[0] === `${upstream.pathname}/token`;
      const grantType = isToken ? new URLSearchParams(body.toString('utf8')).get('grant_type') : null;
      if (grantType === 'refresh_token') {
        refreshes++;
        if (refusing) {
          res.writeHead(400, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: 'invalid_grant', error_description: 'The refresh token was revoked' }));
          return;
        }
      }
      const forward = http.request(
        {
          host: upstream.hostname,
          port: upstream.port,
          method: req.method,
          path: req.url,
          headers: { ...req.headers, 'content-length': String(body.length) },
        },
        (answer) => {
          if (!isToken || answer.statusCode !== 200) {
            res.writeHead(answer.statusCode ?? 502, answer.headers);
            answer.pipe(res);
            return;
          }
          const answerChunks: Buffer[] = [];
          answer.on('data', (c: Buffer) => answerChunks.push(c));
          answer.on('end', () => {
            const tokens = JSON.parse(Buffer.concat(answerChunks).toString('utf8'));
            tokens.access_token = withLifetime(tokens.access_token, lifetimeSeconds, key);
            tokens.expires_in = lifetimeSeconds;
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(JSON.stringify(tokens));
          });
        },
      );
      forward.on('error', (err) => res.destroy(err));
      forward.end(body);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    issuer: `http://127.0.0.1:${port}${upstream.pathname}`,
    refreshes: () => refreshes,
    refuseRefreshes: () => {
      refusing = true;
    },
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}
