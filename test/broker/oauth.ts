// Talks to this checkout's OAuth 2.0 test broker (service `rabbitmq-oauth`
// in test/broker/docker-compose.yml) with access tokens from the mock OIDC
// provider (service `oidc`). Like client.ts, it must not import src/.
//
// Tokens come from the provider's interactive sign-in: the `claims` posted
// with the username are merged into the access token, so a test chooses the
// audience, scopes and expiry. Refresh tokens are real: the refresh grant
// returns a new access token with the same claims.
import * as amqp from 'amqplib';
import { publishedPorts, repoRoot, testBrokerSettings } from '../../scripts/test-broker-env.mjs';

function resolvePorts(): { amqpPort: number; mgmtPort: number; oidcPort: number } {
  const settings = testBrokerSettings(repoRoot, process.env);
  const ports =
    settings.oauthAmqpPort && settings.oauthMgmtPort && settings.oidcPort
      ? { oauthAmqpPort: settings.oauthAmqpPort, oauthMgmtPort: settings.oauthMgmtPort, oidcPort: settings.oidcPort }
      : publishedPorts(settings.project);
  return { amqpPort: Number(ports.oauthAmqpPort), mgmtPort: Number(ports.oauthMgmtPort), oidcPort: Number(ports.oidcPort) };
}

let ports: ReturnType<typeof resolvePorts> | undefined;
const oauthPorts = () => (ports ??= resolvePorts());

export const oauthBroker = {
  host: '127.0.0.1',
  get amqpPort() {
    return oauthPorts().amqpPort;
  },
  get managementUrl() {
    return `http://${this.host}:${oauthPorts().mgmtPort}`;
  },
  /** `resource_server_id` in test/broker/rabbitmq-oauth.conf: the audience tokens must carry, and their scope prefix. */
  audience: 'rabbitmq',
  /** Full permissions on every vhost, and the management UI and API. */
  fullScopes: 'rabbitmq.configure:*/* rabbitmq.read:*/* rabbitmq.write:*/* rabbitmq.tag:management',
};

const issuer = () => `http://127.0.0.1:${oauthPorts().oidcPort}/default`;
const client = { id: 'volveran-broker-facts', secret: 'unused', redirectUri: 'http://127.0.0.1/callback' };

export interface Tokens {
  accessToken: string;
  refreshToken: string;
}

/** The claims of a JWT, unverified. */
export function claimsOf(token: string): Record<string, any> {
  return JSON.parse(Buffer.from(token.split('.')[1] ?? '', 'base64url').toString('utf8'));
}

async function tokenRequest(form: Record<string, string>): Promise<Tokens> {
  const res = await fetch(`${issuer()}/token`, {
    method: 'POST',
    body: new URLSearchParams({ client_id: client.id, client_secret: client.secret, ...form }),
  });
  if (!res.ok) throw new Error(`token request (${form.grant_type}): HTTP ${res.status} ${await res.text()}`);
  const body = (await res.json()) as { access_token: string; refresh_token: string };
  return { accessToken: body.access_token, refreshToken: body.refresh_token };
}

/**
 * Signs `sub` in at the mock provider and returns its tokens. The access
 * token carries the broker's audience and `fullScopes` unless `claims`
 * overrides them; `expiresInSeconds` sets its `exp` (default: the provider's
 * hour).
 */
export async function signIn(
  sub: string,
  options: { claims?: Record<string, unknown>; expiresInSeconds?: number } = {},
): Promise<Tokens> {
  const claims: Record<string, unknown> = { aud: oauthBroker.audience, scope: oauthBroker.fullScopes, ...options.claims };
  if (options.expiresInSeconds !== undefined) claims.exp = Math.floor(Date.now() / 1000) + options.expiresInSeconds;
  const authorize = new URL(`${issuer()}/authorize`);
  for (const [k, v] of Object.entries({
    client_id: client.id,
    redirect_uri: client.redirectUri,
    response_type: 'code',
    scope: 'openid',
    state: 'broker-facts',
  })) {
    authorize.searchParams.set(k, v);
  }
  const res = await fetch(authorize, {
    method: 'POST',
    redirect: 'manual',
    body: new URLSearchParams({ username: sub, claims: JSON.stringify(claims) }),
  });
  const code = new URL(res.headers.get('location') ?? '', client.redirectUri).searchParams.get('code');
  if (!code) throw new Error(`sign-in of ${sub}: HTTP ${res.status}, no code in ${res.headers.get('location')}`);
  return tokenRequest({ grant_type: 'authorization_code', code, redirect_uri: client.redirectUri });
}

/** The refresh grant: new tokens for the same sign-in. */
export function refresh(tokens: Tokens): Promise<Tokens> {
  return tokenRequest({ grant_type: 'refresh_token', refresh_token: tokens.refreshToken });
}

export interface TokenConnection {
  conn: amqp.ChannelModel;
  /** Resolves with the error the broker closed the connection with (a clean close resolves with undefined). */
  closed: Promise<Error | undefined>;
  /** The time `closed` resolved. */
  closedAt(): number | undefined;
}

/**
 * Opens an AMQP connection to the OAuth 2.0 broker with `accessToken` as
 * the password. Errors do not crash the runner; tests observe them through
 * `closed`.
 */
export async function connectWithToken(
  accessToken: string,
  options: { username?: string; connectionName?: string } = {},
): Promise<TokenConnection> {
  const conn = await amqp.connect(
    {
      hostname: oauthBroker.host,
      port: oauthBroker.amqpPort,
      username: options.username ?? '',
      password: accessToken,
    },
    options.connectionName ? { clientProperties: { connection_name: options.connectionName } } : {},
  );
  conn.on('error', () => {});
  let at: number | undefined;
  const closed = new Promise<Error | undefined>((resolve) =>
    conn.on('close', (err?: Error) => {
      at = Date.now();
      resolve(err);
    }),
  );
  return { conn, closed, closedAt: () => at };
}

/**
 * Sends `update-secret` with `accessToken` and resolves with 'accepted', or
 * with the error the broker closed the connection with. (amqplib leaves the
 * update-secret promise pending when the broker answers by closing the
 * connection, so the close is raced.)
 */
export async function updateSecret(tc: TokenConnection, accessToken: string): Promise<'accepted' | Error> {
  return Promise.race([
    tc.conn.updateSecret(Buffer.from(accessToken), 'broker-facts test').then(() => 'accepted' as const),
    tc.closed.then((err) => err ?? new Error('connection closed cleanly')),
  ]);
}

/** A management API call to the OAuth 2.0 broker with `accessToken` as a bearer token; `path` starts after `/api`. */
export async function managementWithToken(path: string, accessToken: string): Promise<{ status: number; body: any }> {
  const res = await fetch(`${oauthBroker.managementUrl}/api${path}`, { headers: { authorization: `Bearer ${accessToken}` } });
  const text = await res.text();
  let body: unknown = text;
  try {
    body = text ? JSON.parse(text) : undefined;
  } catch {
    // not JSON: keep the text
  }
  return { status: res.status, body };
}
