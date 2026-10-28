// Errors reaching a broker through a Broker Profile (management API or AMQP),
// one code per thing the Operator would fix differently: the password
// variable, the network, TLS trust, the credentials, or the broker user's
// permissions.
//
// On a profile with `credentials: operatorToken` (ADR 0008) two are the
// Operator's own: `broker_token_expired` (401, sign in again) and
// `broker_permission_denied` (403, the Operator's broker permissions lack
// something). The shared service account's problems stay 5xx: whoever runs
// Volverán fixes those.
import { HttpError } from './http-error.js';
import type { BrokerProfile } from './profiles.js';

export type BrokerErrorCode =
  | 'password_not_set'
  | 'broker_unreachable'
  | 'tls_failed'
  | 'authentication_failed'
  | 'not_management_user'
  | 'vhost_not_accessible'
  | 'broker_token_expired'
  | 'broker_permission_denied'
  | 'broker_error';

const STATUS: Record<BrokerErrorCode, number> = {
  password_not_set: 500,
  broker_unreachable: 502,
  tls_failed: 502,
  authentication_failed: 502,
  not_management_user: 502,
  vhost_not_accessible: 502,
  broker_token_expired: 401,
  broker_permission_denied: 403,
  broker_error: 502,
};

export class BrokerError extends HttpError<BrokerErrorCode> {
  constructor(code: BrokerErrorCode, message: string, details: Record<string, unknown> = {}) {
    super(STATUS[code], code, message, details);
    this.name = 'BrokerError';
  }
}

/** The Operator's access token has expired and could not be refreshed: they sign in again for a new one. */
export function brokerTokenExpired(profile: BrokerProfile): BrokerError {
  return new BrokerError(
    'broker_token_expired',
    `Broker Profile "${profile.name}" connects with your own access token, which has expired and could not be refreshed. Sign in again to get a new one.`,
    { profile: profile.name, signInUrl: '/auth/login' },
  );
}

/** What the broker refused: a queue, an exchange, a vhost, or the management API itself. */
export interface BrokerResource {
  type: 'queue' | 'exchange' | 'vhost' | 'management';
  /** The queue, exchange or vhost name ("" for the default exchange and the management API). */
  name: string;
  /** The vhost of a queue or exchange. */
  vhost?: string;
}

/** A RabbitMQ permission: configure, write or read on a resource, access to a vhost, or the management tag. */
export type BrokerPermission = 'configure' | 'write' | 'read' | 'access' | 'management';

function describeResource({ type, name, vhost }: BrokerResource): string {
  if (type === 'management') return 'the management API';
  if (type === 'vhost') return `vhost "${name}"`;
  const label = type === 'exchange' && name === '' ? 'the default exchange' : `${type} "${name}"`;
  return `${label} in vhost "${vhost}"`;
}

/**
 * The broker refused `brokerUser` the `permission` on `resource`: 403
 * `broker_permission_denied`, naming both. `hint` says what to grant.
 */
export function brokerPermissionDenied(
  profile: BrokerProfile,
  brokerUser: string,
  resource: BrokerResource,
  permission: BrokerPermission,
  hint = '',
): BrokerError {
  const what = permission === 'access' ? 'access to' : permission === 'management' ? 'the management tag for' : `${permission} permission on`;
  return new BrokerError(
    'broker_permission_denied',
    `The broker refused broker user "${brokerUser}" of Broker Profile "${profile.name}" ${what} ${describeResource(resource)}.` +
      (hint ? ` ${hint}` : ''),
    { profile: profile.name, brokerUser, resource, permission },
  );
}

/** OpenSSL and Node error codes of a failed TLS handshake or certificate check. */
const TLS_ERROR_CODE = /^(ERR_TLS_|ERR_SSL_|CERT_|UNABLE_TO_|DEPTH_ZERO_|SELF_SIGNED_|HOSTNAME_MISMATCH|EPROTO$)/;

/**
 * A socket-level failure (no HTTP or AMQP answer) as a BrokerError:
 * `tls_failed` for a TLS handshake or certificate problem, otherwise
 * `broker_unreachable`. `what` names the endpoint, e.g. "the management API".
 */
export function connectionFailed(profile: BrokerProfile, what: string, url: string, err: unknown): BrokerError {
  const e = err as { code?: unknown; message?: unknown };
  const code = typeof e?.code === 'string' ? e.code : undefined;
  const message = typeof e?.message === 'string' ? e.message : String(err);
  const detail = code && !message.includes(code) ? `${code}: ${message}` : message;
  if (code && TLS_ERROR_CODE.test(code)) {
    const trust = profile.caFile
      ? `Check that ${profile.caFile} (caFile) holds the CA that signed the broker's certificate and that the host name matches it.`
      : `If the broker's certificate is signed by a private CA, set "caFile" on the profile to that CA's PEM file.`;
    return new BrokerError(
      'tls_failed',
      `TLS with ${what} of Broker Profile "${profile.name}" at ${url} failed (${detail}). ${trust}`,
    );
  }
  return new BrokerError(
    'broker_unreachable',
    `Cannot reach ${what} of Broker Profile "${profile.name}" at ${url}: ${detail}.`,
  );
}
