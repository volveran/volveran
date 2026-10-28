// Team Mode test helpers: the mock OIDC provider of this checkout
// (test/broker/docker-compose.yml, service `oidc`) and a minimal browser that
// signs an Operator in through it with a cookie jar.
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
export function teamModeEnv(baseUrl: string): Record<string, string | undefined> {
  return {
    VOLVERAN_AUTH: 'oidc',
    VOLVERAN_OPERATOR: undefined,
    VOLVERAN_OIDC_ISSUER: testOidc.issuer,
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
