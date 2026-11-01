// Team Mode sign-in (ADR 0002): the OIDC authorization code flow with PKCE
// against any OIDC provider, and a server-side session per signed-in person.
//
//   GET  /auth/login?returnTo=/path  starts sign-in: redirect to the provider
//   GET  /auth/callback              the provider sends the browser back here
//   POST /auth/logout                ends the session (204)
//
// The browser only holds a random session id in a signed, HTTP-only,
// SameSite=Lax cookie. Who is signed in, and who is signing in, lives in the
// audit store's session store: in memory on SQLite, so a restart signs everyone
// out; in the database on PostgreSQL, sealed (token-seal.ts), so any Replica can
// finish a sign-in, serve a session or end it, and a restart signs nobody out.
// Every request reads its session there, so signing out ends the session
// everywhere, even for a copied cookie. Every /api/ route answers 401
// `not_signed_in` without a session.
//
// A session ends 12 hours after sign-in, or sooner when its Operator does nothing
// for the idle timeout. Any /api/ request counts, on the Replica that took it (a
// forwarded request reads no session), except one the web app sends on its own while
// nobody may be there (BACKGROUND_REQUEST_HEADER).
//
// A session's OperatorToken is live in each process that has served it, because
// a Checkout's connections listen to it. Each refreshes when its token comes due,
// holding the session's lock in the store: a Replica that finds a later token there
// takes it, as if it had refreshed, so the provider sees each refresh token once.
import { randomBytes } from 'node:crypto';
import fastifyCookie from '@fastify/cookie';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import * as oidc from 'openid-client';
import { BACKGROUND_REQUEST_HEADER } from '../shared/background-request.js';
import type { SessionStore, StoredSession } from './audit/audit-store.js';
import { ConfigError } from './config-error.js';
import { groupsAtSignIn } from './groups-claim.js';
import { HttpError } from './http-error.js';
import { isLoopback } from './is-loopback.js';
import { attachOperator, notSignedIn, teamOperator, type Operator } from './operator.js';
import { grantExpiresAt, OperatorToken, RefreshRefused, type TokenGrant } from './operator-token.js';
import { forwardedSession } from './replicas/forwarding.js';
import type { OidcSettings } from './run-mode.js';
import type { TokenSeal } from './token-seal.js';

const sessionCookie = 'volveran_session';
const loginCookie = 'volveran_login';
/** A session ends this long after sign-in; the Operator signs in again. */
const sessionLifetimeMs = 12 * 60 * 60 * 1000;
/** Time allowed at the provider between /auth/login and /auth/callback. */
const loginLifetimeMs = 10 * 60 * 1000;
/** Sign-ins in progress the store keeps, as anyone can start one. Past it the oldest go: their Operators sign in again. */
export const DEFAULT_MAX_SIGN_INS_IN_PROGRESS = 10_000;
/** A session in use writes to the store at most this often; its idle timeout can end this much early. */
const maxIdleTouchEveryMs = 60 * 1000;

interface PendingLogin {
  codeVerifier: string;
  state: string;
  nonce: string;
  returnTo: string;
}

/** What a session store holds, sealed, of an Operator's tokens. */
interface SealedTokens {
  accessToken: string;
  refreshToken: string | undefined;
  /** Epoch milliseconds; null when nothing says. */
  expiresAt: number | null;
}

/** A session this process has served: its Operator, with the live token. */
interface LiveSession {
  operator: Operator;
  expiresAt: number;
}

export interface TeamAuth {
  register(app: FastifyInstance): Promise<void>;
}

export interface TeamAuthOptions {
  refreshBrokerTokens: boolean;
  /** Where sessions and sign-ins in progress live. */
  sessions: SessionStore;
  /** What protects their tokens there. */
  seal: TokenSeal;
  /** A session the Operator has not used for this long ends. */
  sessionIdleMs: number;
  maxSignInsInProgress: number;
}

/**
 * Reads the provider's discovery document (throwing a ConfigError when it
 * cannot) and returns the sign-in routes and session guard to register.
 */
export async function createTeamAuth(settings: OidcSettings, sessionSecret: string, options: TeamAuthOptions): Promise<TeamAuth> {
  const { sessions, seal, sessionIdleMs, maxSignInsInProgress } = options;
  const idleTouchEveryMs = Math.min(maxIdleTouchEveryMs, sessionIdleMs / 10);
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
  const live = new Map<string, LiveSession>();

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

  /** The refresh grant, for a Broker Profile with `credentials: operatorToken` (operator-token.ts). */
  const refreshGrant = async (refreshToken: string): Promise<TokenGrant> => {
    try {
      const tokens = await oidc.refreshTokenGrant(config, refreshToken);
      return { accessToken: tokens.access_token, expiresIn: tokens.expiresIn(), refreshToken: tokens.refresh_token };
    } catch (err) {
      // The provider answered with an OAuth error (e.g. invalid_grant: revoked or expired).
      if (err instanceof oidc.ResponseBodyError) throw new RefreshRefused(describe(err));
      throw new Error(describe(err));
    }
  };

  const dropLive = (sessionId: string): void => {
    live.get(sessionId)?.operator.brokerToken?.stop();
    live.delete(sessionId);
  };

  const remember = (sessionId: string, session: LiveSession, now: number): void => {
    for (const [id, known] of live) if (known.expiresAt <= now) dropLive(id);
    live.set(sessionId, session);
  };

  const sealTokens = (sessionId: string, grant: TokenGrant, refreshToken: string | undefined, now: number): string => {
    const tokens: SealedTokens = {
      accessToken: grant.accessToken,
      refreshToken,
      expiresAt: grant.expiresIn === undefined ? null : now + grant.expiresIn * 1000,
    };
    return seal.seal(JSON.stringify(tokens), sessionId);
  };

  /** The grant a session store holds; null when its seal cannot be opened here. */
  const openTokens = (sessionId: string, sealed: string, now: number): TokenGrant | null => {
    const opened = seal.open(sealed, sessionId);
    if (opened === null) return null;
    const tokens = JSON.parse(opened) as SealedTokens;
    return {
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      expiresIn: tokens.expiresAt === null ? undefined : (tokens.expiresAt - now) / 1000,
    };
  };

  return {
    async register(app) {
      await app.register(fastifyCookie, { secret: sessionSecret });

      /** The session's token in this process: it refreshes itself until the session ends, and keeps the store up to date. */
      const liveToken = (sessionId: string, grant: TokenGrant, expiresAt: number, operatorId: string, restored: boolean): OperatorToken => {
        const token: OperatorToken = new OperatorToken(
          grant,
          options.refreshBrokerTokens
            ? {
                sessionId,
                refresh: async (refreshToken) => {
                  let fresh: TokenGrant | undefined;
                  try {
                    const found = await sessions.refreshTokens(sessionId, Date.now(), async (sealed) => {
                      const now = Date.now();
                      const stored = openTokens(sessionId, sealed, now);
                      if (stored === null) throw new Error("the session's stored tokens could not be read");
                      // Another Replica got here first. Otherwise this process's refresh token is the one to
                      // send: it is the stored one, or a newer one that could not be saved.
                      const storedUntil = grantExpiresAt(stored, now);
                      if (storedUntil !== undefined && (token.expiresAt === undefined || storedUntil > token.expiresAt)) {
                        fresh = stored;
                        return null;
                      }
                      fresh = await refreshGrant(refreshToken);
                      return sealTokens(sessionId, fresh, fresh.refreshToken ?? refreshToken, Date.now());
                    });
                    if (!found) {
                      // Signed out on another Replica since this one last served the session.
                      dropLive(sessionId);
                      throw new RefreshRefused('the session has ended');
                    }
                  } catch (err) {
                    if (fresh === undefined) throw err;
                    // The grant is good, and this process carries on with it. After a restart the Operator may have to sign in again.
                    app.log.error({ err, operator: operatorId }, "The Operator's refreshed tokens could not be saved");
                  }
                  return fresh!;
                },
                until: expiresAt,
                refreshPastExpiry: restored,
                onFailure: (reason, final) =>
                  app.log.warn(
                    { operator: operatorId, reason },
                    final
                      ? "Could not refresh the Operator's access token: their broker connections close when it expires, and they must sign in again"
                      : "Could not refresh the Operator's access token; trying again",
                  ),
              }
            : { sessionId },
        );
        return token;
      };

      /** The session as this process serves it, made live the first time it is seen here. */
      const goLive = (sessionId: string, stored: StoredSession, now: number): LiveSession | null => {
        const known = live.get(sessionId);
        if (known) return known;
        const grant = openTokens(sessionId, stored.tokens, now);
        if (grant === null) {
          app.log.warn({ operator: stored.operator.id }, "A session's tokens could not be read: VOLVERAN_SESSION_ENCRYPTION_KEY has changed, or differs between Replicas. The Operator must sign in again");
          return null;
        }
        const session: LiveSession = {
          operator: { ...stored.operator, brokerToken: liveToken(sessionId, grant, stored.expiresAt, stored.operator.id, true) },
          expiresAt: stored.expiresAt,
        };
        remember(sessionId, session, now);
        return session;
      };

      // Sessions die with the app: no more token refreshes.
      app.addHook('onClose', async () => {
        for (const session of live.values()) session.operator.brokerToken?.stop();
      });

      /** Moves the idle expiry for a request that counts. One set further ahead (from before the timeout, or a longer one) always comes back. */
      const touch = async (req: FastifyRequest, sessionId: string, stored: StoredSession, now: number): Promise<void> => {
        const idleExpiresAt = now + sessionIdleMs;
        const counts = req.headers[BACKGROUND_REQUEST_HEADER] === undefined;
        if (stored.idleExpiresAt <= idleExpiresAt && !(counts && idleExpiresAt - stored.idleExpiresAt >= idleTouchEveryMs)) return;
        try {
          await sessions.touchSession(sessionId, idleExpiresAt);
        } catch (err) {
          // The session was just read, and the next request tries again.
          req.log.error({ err, operator: stored.operator.id }, "A session's idle timeout could not be moved");
        }
      };

      // Only /api/ has an Operator: a probe or a static file with a cookie must not depend on the store.
      attachOperator(app, async (req) => {
        if (!underApi(req)) return null;
        const sessionId = readCookie(req, sessionCookie);
        if (!sessionId) return null;
        const now = Date.now();
        const stored = await sessions.session(sessionId, now);
        if (!stored) {
          dropLive(sessionId);
          return null;
        }
        await touch(req, sessionId, stored, now);
        return goLive(sessionId, stored, now)?.operator ?? null;
      });
      // A forwarded Operator comes with their session's id, not its tokens: this Replica uses the session's token from the store.
      app.addHook('onRequest', async (req) => {
        const sessionId = forwardedSession(req.raw);
        if (!sessionId || !req.operator) return;
        const now = Date.now();
        const stored = await sessions.session(sessionId, now);
        const session = stored && goLive(sessionId, stored, now);
        if (session?.operator.id === req.operator.id) req.operator = { ...req.operator, brokerToken: session.operator.brokerToken };
      });
      app.addHook('onRequest', async (req) => {
        if (underApi(req) && !req.operator) throw notSignedIn();
      });

      app.get<{ Querystring: { returnTo?: string } }>('/auth/login', async (req, reply) => {
        const codeVerifier = oidc.randomPKCECodeVerifier();
        const login: PendingLogin = {
          codeVerifier,
          state: oidc.randomState(),
          nonce: oidc.randomNonce(),
          returnTo: safeReturnTo(req.query.returnTo),
        };
        const id = randomBytes(32).toString('base64url');
        const now = Date.now();
        await sessions.addSignIn(id, { sealed: seal.seal(JSON.stringify(login), id), expiresAt: now + loginLifetimeMs }, now, maxSignInsInProgress);
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
        const sealed = loginId ? await sessions.takeSignIn(loginId, Date.now()) : null;
        const opened = sealed === null ? null : seal.open(sealed, loginId!);
        reply.clearCookie(loginCookie, { path: '/auth' });
        if (opened === null) {
          throw signInFailed('this browser has no sign-in in progress, or it took longer than 10 minutes');
        }
        const login = JSON.parse(opened) as PendingLogin;

        // The provider saw the redirect URL as configured; rebuild it with this
        // request's query, since a reverse proxy may change host and path.
        const query = req.url.includes('?') ? req.url.slice(req.url.indexOf('?')) : '';
        let operator: Operator;
        let tokens: Awaited<ReturnType<typeof oidc.authorizationCodeGrant>>;
        try {
          tokens = await oidc.authorizationCodeGrant(config, new URL(redirectUrl.origin + redirectUrl.pathname + query), {
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
          // What the provider said is for the Operator; anything else is about Volverán's side of it.
          if (err instanceof oidc.AuthorizationResponseError || err instanceof oidc.ResponseBodyError) throw signInFailed(describe(err));
          req.log.warn({ reason: describe(err) }, 'A sign-in failed');
          throw signInFailed("the provider's answer could not be used");
        }

        const now = Date.now();
        const expiresAt = now + sessionLifetimeMs;
        const sessionId = randomBytes(32).toString('base64url');
        const grant: TokenGrant = { accessToken: tokens.access_token, expiresIn: tokens.expiresIn(), refreshToken: tokens.refresh_token };
        await sessions.addSession(sessionId, { operator, tokens: sealTokens(sessionId, grant, grant.refreshToken, now), expiresAt, idleExpiresAt: now + sessionIdleMs }, now);
        // Kept with the session's Operator, never sent to the browser or logged:
        // profiles with `credentials: operatorToken` connect with it (ADR 0008),
        // and it refreshes itself until the session ends.
        remember(sessionId, { operator: { ...operator, brokerToken: liveToken(sessionId, grant, expiresAt, operator.id, false) }, expiresAt }, now);
        reply.setCookie(sessionCookie, sessionId, cookieOptions(sessionLifetimeMs, '/'));
        return reply.redirect(login.returnTo);
      });

      app.post('/auth/logout', async (req, reply) => {
        const sessionId = readCookie(req, sessionCookie);
        if (sessionId) {
          await sessions.removeSession(sessionId);
          dropLive(sessionId);
        }
        reply.clearCookie(sessionCookie, { path: '/' });
        return reply.status(204).send();
      });
    },
  };
}

/**
 * Whether the request is for /api/. The router decodes a path and the raw URL is not decoded, so
 * `/%61pi/session` reaches an /api/ route; a path no route has, or the web app's wildcard, shows only in the raw URL.
 */
function underApi(req: FastifyRequest): boolean {
  return req.routeOptions.url?.startsWith('/api/') === true || req.url.startsWith('/api/');
}

function signInFailed(reason: string): HttpError<'sign_in_failed'> {
  return new HttpError(400, 'sign_in_failed', `Sign-in failed: ${reason}. Sign in again.`, { signInUrl: '/auth/login' });
}

/**
 * Only a path of this app, as a browser reads it: it strips tabs and newlines and takes `\` as `/`.
 * So the value is resolved the same way, and the path it resolves to is what the redirect uses.
 */
function safeReturnTo(value: string | undefined): string {
  if (!value?.startsWith('/')) return '/';
  const base = 'http://return-to.invalid';
  let url: URL;
  try {
    url = new URL(value, base);
  } catch {
    return '/';
  }
  // Dots can leave `//` at the front of a path that resolved here.
  if (url.origin !== base || url.pathname.startsWith('//')) return '/';
  return url.pathname + url.search + url.hash;
}

function describe(err: unknown): string {
  if (err instanceof oidc.AuthorizationResponseError || err instanceof oidc.ResponseBodyError) {
    return err.error_description ? `${err.error} (${err.error_description})` : err.error;
  }
  const e = err as { message?: string; cause?: { message?: string } };
  const cause = e.cause?.message ? ` (${e.cause.message})` : '';
  return `${e.message ?? String(err)}${cause}`;
}
