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
// A session's OperatorToken is live in each process that has served it, because
// a Checkout's connections listen to it. Each one refreshes on its own; making
// that safe across Replicas is #114.
import { randomBytes } from 'node:crypto';
import fastifyCookie from '@fastify/cookie';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import * as oidc from 'openid-client';
import type { SessionStore, StoredSession } from './audit/audit-store.js';
import { ConfigError } from './config-error.js';
import { groupsAtSignIn } from './groups-claim.js';
import { HttpError } from './http-error.js';
import { isLoopback } from './is-loopback.js';
import { attachOperator, notSignedIn, teamOperator, type Operator } from './operator.js';
import { OperatorToken, RefreshRefused, type TokenGrant } from './operator-token.js';
import type { OidcSettings } from './run-mode.js';
import type { TokenSeal } from './token-seal.js';

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
}

/**
 * Reads the provider's discovery document (throwing a ConfigError when it
 * cannot) and returns the sign-in routes and session guard to register.
 */
export async function createTeamAuth(settings: OidcSettings, sessionSecret: string, options: TeamAuthOptions): Promise<TeamAuth> {
  const { sessions, seal } = options;
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

  return {
    async register(app) {
      await app.register(fastifyCookie, { secret: sessionSecret });

      /** The session's token in this process: it refreshes itself until the session ends, and keeps the store up to date. */
      const liveToken = (sessionId: string, grant: TokenGrant, expiresAt: number, operatorId: string, restored: boolean): OperatorToken =>
        new OperatorToken(
          grant,
          options.refreshBrokerTokens
            ? {
                refresh: async (refreshToken) => {
                  // Signed out on another Replica since this one last served the session.
                  if (!(await sessions.session(sessionId, Date.now()))) {
                    dropLive(sessionId);
                    throw new RefreshRefused('the session has ended');
                  }
                  const fresh = await refreshGrant(refreshToken);
                  try {
                    await sessions.setTokens(sessionId, sealTokens(sessionId, fresh, fresh.refreshToken ?? refreshToken, Date.now()));
                  } catch (err) {
                    // The grant is good, and this process carries on with it. After a restart the Operator may have to sign in again.
                    app.log.error({ err, operator: operatorId }, "The Operator's refreshed tokens could not be saved");
                  }
                  return fresh;
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
            : {},
        );

      /** The session as this process serves it, made live the first time it is seen here. */
      const goLive = (sessionId: string, stored: StoredSession, now: number): LiveSession | null => {
        const known = live.get(sessionId);
        if (known) return known;
        const opened = seal.open(stored.tokens, sessionId);
        if (opened === null) {
          app.log.warn({ operator: stored.operator.id }, "A session's tokens could not be read: VOLVERAN_SESSION_ENCRYPTION_KEY has changed, or differs between Replicas. The Operator must sign in again");
          return null;
        }
        const tokens = JSON.parse(opened) as SealedTokens;
        const grant: TokenGrant = {
          accessToken: tokens.accessToken,
          refreshToken: tokens.refreshToken,
          expiresIn: tokens.expiresAt === null ? undefined : (tokens.expiresAt - now) / 1000,
        };
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

      // Only /api/ has an Operator: a probe or a static file with a cookie must not depend on the store.
      attachOperator(app, async (req) => {
        if (!req.url.startsWith('/api/')) return null;
        const sessionId = readCookie(req, sessionCookie);
        if (!sessionId) return null;
        const now = Date.now();
        const stored = await sessions.session(sessionId, now);
        if (!stored) {
          dropLive(sessionId);
          return null;
        }
        return goLive(sessionId, stored, now)?.operator ?? null;
      });
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
        };
        const id = randomBytes(32).toString('base64url');
        const now = Date.now();
        await sessions.addSignIn(id, { sealed: seal.seal(JSON.stringify(login), id), expiresAt: now + loginLifetimeMs }, now);
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
          throw signInFailed(describe(err));
        }

        const now = Date.now();
        const expiresAt = now + sessionLifetimeMs;
        const sessionId = randomBytes(32).toString('base64url');
        const grant: TokenGrant = { accessToken: tokens.access_token, expiresIn: tokens.expiresIn(), refreshToken: tokens.refresh_token };
        await sessions.addSession(sessionId, { operator, tokens: sealTokens(sessionId, grant, grant.refreshToken, now), expiresAt }, now);
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

function signInFailed(reason: string): HttpError<'sign_in_failed'> {
  return new HttpError(400, 'sign_in_failed', `Sign-in failed: ${reason}. Sign in again.`, { signInUrl: '/auth/login' });
}

/** Only a path of this app: never another site (`//host`, `/\host`, `https://...`). */
function safeReturnTo(value: string | undefined): string {
  if (!value || !value.startsWith('/') || value.startsWith('//') || value.startsWith('/\\')) return '/';
  return value;
}

function describe(err: unknown): string {
  if (err instanceof oidc.AuthorizationResponseError || err instanceof oidc.ResponseBodyError) {
    return err.error_description ? `${err.error} (${err.error_description})` : err.error;
  }
  const e = err as { message?: string; cause?: { message?: string } };
  const cause = e.cause?.message ? ` (${e.cause.message})` : '';
  return `${e.message ?? String(err)}${cause}`;
}
