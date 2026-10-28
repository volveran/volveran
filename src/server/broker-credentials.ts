// What Volverán authenticates to a broker with, for one Operator on one
// Broker Profile: the one place that turns a profile's `credentials` into a
// user name and password (AMQP) or an Authorization header (management API).
//
//   shared         the profile's username and the password from passwordEnv
//   operatorToken  the Operator's own access token (operator-token.ts, ADR
//                  0008): the AMQP password, and a bearer token for the
//                  management API. RabbitMQ ignores the AMQP user name and
//                  takes the user from the token; Volverán records the
//                  profile's `tokenUsernameClaim` (else `sub`, as RabbitMQ
//                  falls back) as the broker user in Audit Entries.
//
// Resolved each time a connection opens or a management call is made, never
// cached, so a management call sends the current (refreshed) token, and an
// expired one answers 401 `broker_token_expired` then. A connection opened
// with a token keeps it fresh with `update-secret` (amqp-connection.ts).
import { BrokerError, brokerTokenExpired } from './broker-error.js';
import type { Operator } from './operator.js';
import type { OperatorToken } from './operator-token.js';
import type { BrokerProfile } from './profiles.js';

export interface BrokerCredentials {
  kind: BrokerProfile['credentials']['kind'];
  /** The AMQP user name (ignored by the broker for a token). */
  username: string;
  /** The AMQP password: the shared password, or the access token. */
  password: string;
  /** The management API's Authorization header. */
  authorization: string;
  /** The broker user as RabbitMQ sees it: the Audit Entry's broker user. */
  brokerUser: string;
  /** Whose credentials these are, for error messages. */
  describe: string;
  /** operatorToken: the token itself, whose refreshes a connection opened with it follows. */
  token?: OperatorToken;
}

export function brokerCredentials(profile: BrokerProfile, operator: Operator): BrokerCredentials {
  const { credentials } = profile;
  if (credentials.kind === 'shared') {
    if (credentials.password === undefined) {
      throw new BrokerError(
        'password_not_set',
        `Broker Profile "${profile.name}": environment variable ${credentials.passwordEnv} is not set, so there is no password to connect with.`,
      );
    }
    return {
      kind: 'shared',
      username: credentials.username,
      password: credentials.password,
      authorization: `Basic ${Buffer.from(`${credentials.username}:${credentials.password}`).toString('base64')}`,
      brokerUser: credentials.username,
      describe: `user "${credentials.username}", password from ${credentials.passwordEnv}`,
    };
  }
  const token = operator.brokerToken;
  const accessToken = token?.valid();
  if (!token || !accessToken) throw brokerTokenExpired(profile);
  const brokerUser = token.claim(credentials.tokenUsernameClaim) ?? token.claim('sub') ?? operator.id;
  return {
    kind: 'operatorToken',
    username: brokerUser,
    password: accessToken,
    authorization: `Bearer ${accessToken}`,
    brokerUser,
    describe: `the access token of ${operator.displayName}, broker user "${brokerUser}"`,
    token,
  };
}
