// Team Mode sign-in (ADR 0002): the OIDC authorization code flow with PKCE
// against any OIDC provider, and a server-side session per signed-in person.
//
//   GET  /auth/login?returnTo=/path  starts sign-in: redirect to the provider
//   GET  /auth/callback              the provider sends the browser back here
//   POST /auth/logout                ends the session (204)
//
// The browser only holds a random session id in a signed, HTTP-only,
// SameSite=Lax cookie; who is signed in lives in this process, so signing out
// ends the session even for a copied cookie, and a restart signs everyone out.
// Every /api/ route answers 401 `not_signed_in` without a session.
import { randomBytes } from 'node:crypto';
import fastifyCookie from '@fastify/cookie';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import * as oidc from 'openid-client';
import { ConfigError } from './config-error.js';
import { groupsAtSignIn } from './groups-claim.js';
import { HttpError } from './http-error.js';
import { isLoopback } from './is-loopback.js';
import { attachOperator, notSignedIn, teamOperator, type Operator } from './operator.js';
import type { OidcSettings } from './run-mode.js';

const sessionCookie = 'volveran_session';
const loginCookie = 'volveran_login';
/** A session ends this long after sign-in; the Operator signs in again. */
const sessionLifetimeMs = 12 * 60 * 60 * 1000;
/** Time allowed at the provider between /auth/login and /auth/callback. */
const loginLifetimeMs = 10 * 60 * 1000;

interface PendingLogin {
  codeVerifier: string;
  state: string;
  nonce: string;
  returnTo: string;
  expiresAt: number;
}

interface Session {
  /** Who signed in, with their groups. */
  operator: Operator;
  expiresAt: number;
}

/** Entries that expire; expired ones are dropped when read and swept on insert. */
class ExpiringMap<T extends { expiresAt: number }> {
  private readonly entries = new Map<string, T>();

  add(value: T): string {
    const now = Date.now();
    for (const [id, entry] of this.entries) if (entry.expiresAt <= now) this.entries.delete(id);
    const id = randomBytes(32).toString('base64url');
    this.entries.set(id, value);
    return id;
  }

  get(id: string | undefined): T | undefined {
    if (!id) return undefined;
    const entry = this.entries.get(id);
    if (entry && entry.expiresAt <= Date.now()) {
      this.entries.delete(id);
      return undefined;
    }
    return entry;
  }

  delete(id: string | undefined): void {
    if (id) this.entries.delete(id);
  }
}

export interface TeamAuth {
  register(app: FastifyInstance): Promise<void>;
}

/**
 * Reads the provider's discovery document (throwing a ConfigError when it
 * cannot) and returns the sign-in routes and session guard to register.
 */
export async function createTeamAuth(settings: OidcSettings, sessionSecret: string): Promise<TeamAuth> {
  const issuer = new URL(settings.issuer);
  let config: oidc.Configuration;
  try {
    config = await oidc.discovery(
      issuer,
      settings.clientId,
      undefined,
      oidc.ClientSecretPost(settings.clientSecret),
      // run-mode.ts allows plain http only for a provider on this machine.
      issuer.protocol === 'http:' && isLoopback(issuer.hostname.replace(/^\[|\]$/g, ''))
        ? { execute: [oidc.allowInsecureRequests] }
        : undefined,
    );
  } catch (err) {
    throw new ConfigError(
      `Could not read the OIDC provider's discovery document at ${settings.issuer} ` +
        `(VOLVERAN_OIDC_ISSUER): ${describe(err)}. Check the issuer URL and that Volverán can reach the provider.`,
    );
  }

  const redirectUrl = new URL(settings.redirectUrl);
  const secure = redirectUrl.protocol === 'https:';
  const logins = new ExpiringMap<PendingLogin>();
  const sessions = new ExpiringMap<Session>();

  const readCookie = (req: FastifyRequest, name: string): string | undefined => {
    const raw = req.cookies[name];
    if (!raw) return undefined;
    const unsigned = req.unsignCookie(raw);
    return unsigned.valid && unsigned.value ? unsigned.value : undefined;
  };
  const cookieOptions = (maxAgeMs: number, path: string) => ({
    signed: true,
    httpOnly: true,
    sameSite: 'lax' as const,
    secure,
    path,
    maxAge: Math.floor(maxAgeMs / 1000),
  });

  return {
    async register(app) {
      await app.register(fastifyCookie, { secret: sessionSecret });

      attachOperator(app, (req) => sessions.get(readCookie(req, sessionCookie))?.operator ?? null);
      app.addHook('onRequest', async (req) => {
        if (req.url.startsWith('/api/') && !req.operator) throw notSignedIn();
      });

      app.get<{ Querystring: { returnTo?: string } }>('/auth/login', async (req, reply) => {
        const codeVerifier = oidc.randomPKCECodeVerifier();
        const login: PendingLogin = {
          codeVerifier,
          state: oidc.randomState(),
          nonce: oidc.randomNonce(),
          returnTo: safeReturnTo(req.query.returnTo),
          expiresAt: Date.now() + loginLifetimeMs,
        };
        const id = logins.add(login);
        const authorizeUrl = oidc.buildAuthorizationUrl(config, {
          redirect_uri: settings.redirectUrl,
          scope: settings.scopes.join(' '),
          code_challenge: await oidc.calculatePKCECodeChallenge(codeVerifier),
          code_challenge_method: 'S256',
          state: login.state,
          nonce: login.nonce,
        });
        reply.setCookie(loginCookie, id, cookieOptions(loginLifetimeMs, '/auth'));
        return reply.redirect(authorizeUrl.href);
      });

      app.get('/auth/callback', async (req, reply) => {
        const loginId = readCookie(req, loginCookie);
        const login = logins.get(loginId);
        logins.delete(loginId);
        reply.clearCookie(loginCookie, { path: '/auth' });
        if (!login) {
          throw signInFailed('this browser has no sign-in in progress, or it took longer than 10 minutes');
        }

        // The provider saw the redirect URL as configured; rebuild it with this
        // request's query, since a reverse proxy may change host and path.
        const query = req.url.includes('?') ? req.url.slice(req.url.indexOf('?')) : '';
        let operator: Operator;
        try {
          const tokens = await oidc.authorizationCodeGrant(config, new URL(redirectUrl.origin + redirectUrl.pathname + query), {
            pkceCodeVerifier: login.codeVerifier,
            expectedState: login.state,
            expectedNonce: login.nonce,
            idTokenExpected: true,
          });
          const claims = tokens.claims();
          if (!claims?.sub) throw new Error('the ID token has no "sub" claim');
          const groups = await groupsAtSignIn({
            idToken: claims,
            claim: settings.groupsClaim,
            userinfo: config.serverMetadata().userinfo_endpoint
              ? () => oidc.fetchUserInfo(config, tokens.access_token, claims.sub)
              : null,
            log: req.log,
          });
          operator = teamOperator(claims, groups);
        } catch (err) {
          throw signInFailed(describe(err));
        }

        const sessionId = sessions.add({ operator, expiresAt: Date.now() + sessionLifetimeMs });
        reply.setCookie(sessionCookie, sessionId, cookieOptions(sessionLifetimeMs, '/'));
        return reply.redirect(login.returnTo);
      });

      app.post('/auth/logout', async (req, reply) => {
        sessions.delete(readCookie(req, sessionCookie));
        reply.clearCookie(sessionCookie, { path: '/' });
        return reply.status(204).send();
      });
    },
  };
}

function signInFailed(reason: string): HttpError<'sign_in_failed'> {
  return new HttpError(400, 'sign_in_failed', `Sign-in failed: ${reason}. Sign in again.`, { signInUrl: '/auth/login' });
}

/** Only a path of this app: never another site (`//host`, `/\host`, `https://...`). */
function safeReturnTo(value: string | undefined): string {
  if (!value || !value.startsWith('/') || value.startsWith('//') || value.startsWith('/\\')) return '/';
  return value;
}

function describe(err: unknown): string {
  if (err instanceof oidc.AuthorizationResponseError) {
    return err.error_description ? `${err.error} (${err.error_description})` : err.error;
  }
  const e = err as { message?: string; cause?: { message?: string } };
  const cause = e.cause?.message ? ` (${e.cause.message})` : '';
  return `${e.message ?? String(err)}${cause}`;
}
