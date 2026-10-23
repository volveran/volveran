// Errors reaching a broker through a Broker Profile (management API or AMQP),
// one code per thing the Operator would fix differently: the password
// variable, the network, TLS trust, the credentials, or the broker user's
// permissions.
import { HttpError } from './http-error.js';
import type { BrokerProfile } from './profiles.js';

export type BrokerErrorCode =
  | 'password_not_set'
  | 'broker_unreachable'
  | 'tls_failed'
  | 'authentication_failed'
  | 'not_management_user'
  | 'vhost_not_accessible'
  | 'broker_error';

const STATUS: Record<BrokerErrorCode, number> = {
  password_not_set: 500,
  broker_unreachable: 502,
  tls_failed: 502,
  authentication_failed: 502,
  not_management_user: 502,
  vhost_not_accessible: 502,
  broker_error: 502,
};

export class BrokerError extends HttpError<BrokerErrorCode> {
  constructor(code: BrokerErrorCode, message: string) {
    super(STATUS[code], code, message);
    this.name = 'BrokerError';
  }
}

/** The profile's password, or a `password_not_set` BrokerError when its variable isn't set. */
export function requirePassword(profile: BrokerProfile): string {
  if (profile.password === undefined) {
    throw new BrokerError(
      'password_not_set',
      `Broker Profile "${profile.name}": environment variable ${profile.passwordEnv} is not set, so there is no password to connect with.`,
    );
  }
  return profile.password;
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
