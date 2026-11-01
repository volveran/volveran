// Pure startup check (no I/O) of how Volverán runs (ADR 0002). Solo Mode
// (`VOLVERAN_AUTH=none`, the default) has no sign-in, so it refuses any listen
// address but loopback and takes the Operator's name from the configuration.
// Team Mode (`VOLVERAN_AUTH=oidc`) signs Operators in through an OIDC provider
// and is the only way to listen on the network.
import { isLoopback } from './is-loopback.js';

/** The OIDC client settings of Team Mode. */
export interface OidcSettings {
  /** The provider's issuer URL; its discovery document is read at startup. */
  issuer: string;
  clientId: string;
  clientSecret: string;
  /** Where the provider sends the browser back: Volverán's `/auth/callback` as the browser reaches it. */
  redirectUrl: string;
  scopes: string[];
  /** The claim holding the Operator's groups, for their Roles: a dotted path, read from the ID token, else userinfo (VOLVERAN_OIDC_GROUPS_CLAIM). */
  groupsClaim: string;
}

export type RunMode =
  | { kind: 'solo'; operator: string }
  | {
      kind: 'team';
      oidc: OidcSettings;
      /** Signs the session cookie. */
      sessionSecret: string;
      /** Encrypts the tokens of sessions kept at rest: set on PostgreSQL only (with SQLite, sessions stay in memory). */
      sessionEncryptionKey?: string;
    };

export type RunModeResult = { ok: true; mode: RunMode } | { ok: false; error: string };

/** The route the provider redirects back to (see auth.ts). */
export const callbackPath = '/auth/callback';

const minSessionSecretLength = 32;
const defaultScopes = 'openid email profile';
const defaultGroupsClaim = 'groups';

export function resolveRunMode(env: Record<string, string | undefined>, host: string): RunModeResult {
  const auth = env.VOLVERAN_AUTH?.trim() || 'none';
  if (auth === 'oidc') return resolveTeamMode(env);
  if (auth !== 'none') {
    return { ok: false, error: `VOLVERAN_AUTH must be "none" (Solo Mode) or "oidc" (Team Mode), not "${auth}".` };
  }

  if (!isLoopback(host)) {
    return {
      ok: false,
      error:
        `Solo Mode has no sign-in, so it only listens on a loopback address (127.0.0.1, ::1 or localhost), ` +
        `not on "${host}": anyone who could reach it would act on your brokers with your Broker Profiles. ` +
        `Set VOLVERAN_HOST=127.0.0.1. In Docker, run the container with --network host so the browser on this ` +
        `machine reaches it; to share Volverán with a team, run it in Team Mode (VOLVERAN_AUTH=oidc).`,
    };
  }

  const operator = env.VOLVERAN_OPERATOR?.trim() || env.USER?.trim();
  if (!operator) {
    return {
      ok: false,
      error:
        'Solo Mode records your name as the Operator of every action, but neither VOLVERAN_OPERATOR nor USER is set. ' +
        'Set VOLVERAN_OPERATOR to your name (in Docker: -e VOLVERAN_OPERATOR=$USER).',
    };
  }
  return { ok: true, mode: { kind: 'solo', operator } };
}

function resolveTeamMode(env: Record<string, string | undefined>): RunModeResult {
  const read = (name: string) => env[name]?.trim() || undefined;
  const required = [
    'VOLVERAN_OIDC_ISSUER',
    'VOLVERAN_OIDC_CLIENT_ID',
    'VOLVERAN_OIDC_CLIENT_SECRET',
    'VOLVERAN_OIDC_REDIRECT_URL',
    'VOLVERAN_SESSION_SECRET',
  ];
  const missing = required.filter((name) => !read(name));
  if (missing.length > 0) {
    return {
      ok: false,
      error: `Team Mode (VOLVERAN_AUTH=oidc) signs Operators in through your OIDC provider and needs ${missing.join(', ')}. See README "Team Mode" and docs/team-mode.md.`,
    };
  }

  const issuer = checkUrl('VOLVERAN_OIDC_ISSUER', read('VOLVERAN_OIDC_ISSUER')!);
  if (!issuer.ok) return issuer;
  const redirect = checkUrl('VOLVERAN_OIDC_REDIRECT_URL', read('VOLVERAN_OIDC_REDIRECT_URL')!);
  if (!redirect.ok) return redirect;
  if (!redirect.url.pathname.endsWith(callbackPath)) {
    return {
      ok: false,
      error: `VOLVERAN_OIDC_REDIRECT_URL must point at Volverán's ${callbackPath} route (e.g. https://volveran.example.com${callbackPath}), not "${redirect.url.href}".`,
    };
  }

  const scopes = (read('VOLVERAN_OIDC_SCOPES') ?? defaultScopes).split(/\s+/);
  if (!scopes.includes('openid')) {
    return { ok: false, error: `VOLVERAN_OIDC_SCOPES must include "openid", not "${scopes.join(' ')}".` };
  }

  const sessionSecret = read('VOLVERAN_SESSION_SECRET')!;
  if (sessionSecret.length < minSessionSecretLength) {
    return {
      ok: false,
      error: `VOLVERAN_SESSION_SECRET must be at least ${minSessionSecretLength} characters long (e.g. the output of \`openssl rand -hex 32\`).`,
    };
  }

  // Sessions are at rest in the store only on PostgreSQL.
  let sessionEncryptionKey: string | undefined;
  if (read('VOLVERAN_POSTGRES_URL')) {
    sessionEncryptionKey = read('VOLVERAN_SESSION_ENCRYPTION_KEY');
    if (!sessionEncryptionKey) {
      return {
        ok: false,
        error:
          'Team Mode on PostgreSQL keeps sessions in the database, with their tokens encrypted, and needs VOLVERAN_SESSION_ENCRYPTION_KEY: ' +
          `at least ${minSessionSecretLength} characters (e.g. the output of \`openssl rand -hex 32\`), the same on every Replica.`,
      };
    }
    if (sessionEncryptionKey.length < minSessionSecretLength) {
      return { ok: false, error: `VOLVERAN_SESSION_ENCRYPTION_KEY must be at least ${minSessionSecretLength} characters long (e.g. the output of \`openssl rand -hex 32\`).` };
    }
    if (sessionEncryptionKey === sessionSecret) {
      return { ok: false, error: 'VOLVERAN_SESSION_ENCRYPTION_KEY must differ from VOLVERAN_SESSION_SECRET: one encrypts tokens in the database, the other signs cookies.' };
    }
  }

  // A dotted path into the claims (groups-claim.ts): no empty step.
  const groupsClaim = read('VOLVERAN_OIDC_GROUPS_CLAIM') ?? defaultGroupsClaim;
  if (groupsClaim.split('.').includes('')) {
    return {
      ok: false,
      error: `VOLVERAN_OIDC_GROUPS_CLAIM is a claim name or a dotted path to one (e.g. groups or realm_access.roles), not "${groupsClaim}".`,
    };
  }

  return {
    ok: true,
    mode: {
      kind: 'team',
      oidc: {
        issuer: read('VOLVERAN_OIDC_ISSUER')!,
        clientId: read('VOLVERAN_OIDC_CLIENT_ID')!,
        clientSecret: read('VOLVERAN_OIDC_CLIENT_SECRET')!,
        redirectUrl: read('VOLVERAN_OIDC_REDIRECT_URL')!,
        scopes,
        groupsClaim,
      },
      sessionSecret,
      ...(sessionEncryptionKey !== undefined && { sessionEncryptionKey }),
    },
  };
}

/** An absolute http(s) URL; plain http only on this machine, since codes and tokens cross it. */
function checkUrl(name: string, value: string): { ok: true; url: URL } | { ok: false; error: string } {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return { ok: false, error: `${name} must be an absolute URL, not "${value}".` };
  }
  if (url.protocol === 'https:') return { ok: true, url };
  if (url.protocol === 'http:' && isLoopback(url.hostname.replace(/^\[|\]$/g, ''))) return { ok: true, url };
  return {
    ok: false,
    error: `${name} must use https (plain http is only allowed for localhost or 127.0.0.1), not "${value}".`,
  };
}
