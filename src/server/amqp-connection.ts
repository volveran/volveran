// Opens an AMQP connection for a Broker Profile to one vhost, named so the
// broker's connection list shows what it is for. Failures become BrokerErrors
// with the same codes as the management API. `credentials` come from
// broker-credentials.ts: the shared account, or the Operator's own token as
// the password (ADR 0008).
import tls from 'node:tls';
import * as amqp from 'amqplib';
import type { BrokerCredentials } from './broker-credentials.js';
import { BrokerError, connectionFailed } from './broker-error.js';
import type { BrokerProfile } from './profiles.js';

/**
 * The returned connection already has an `error` listener (amqplib emits
 * `error` before `close` when the broker closes a connection, and an
 * unlistened `error` would crash the process); callers react to `close`.
 */
export async function openAmqpConnection(
  profile: BrokerProfile,
  credentials: BrokerCredentials,
  vhost: string,
  connectionName: string,
): Promise<amqp.ChannelModel> {
  const url = new URL(profile.amqpUrl);
  url.username = encodeURIComponent(credentials.username);
  url.password = encodeURIComponent(credentials.password);
  url.pathname = '/' + encodeURIComponent(vhost);
  let conn: amqp.ChannelModel;
  try {
    conn = await amqp.connect(url.toString(), {
      clientProperties: { connection_name: connectionName },
      // Apply waits for a round trip after each step; without this Nagle's
      // algorithm adds ~40 ms to each one.
      noDelay: true,
      ...(profile.ca ? { ca: [...tls.rootCertificates, profile.ca.toString('utf8')] } : {}),
    });
  } catch (err) {
    throw amqpFailure(profile, credentials, vhost, err);
  }
  conn.on('error', () => {});
  return conn;
}

function amqpFailure(profile: BrokerProfile, credentials: BrokerCredentials, vhost: string, err: unknown): BrokerError {
  const message = err instanceof Error ? err.message : String(err);
  if (/ACCESS[-_]REFUSED/.test(message)) {
    return new BrokerError(
      'authentication_failed',
      `The broker rejected the credentials of Broker Profile "${profile.name}" over AMQP (${credentials.describe}).`,
    );
  }
  // The broker refuses connection.open (530 NOT_ALLOWED) when the vhost is
  // missing or the user has no permissions on it; amqplib 2 reports only that
  // a ConnectionClose came instead of ConnectionOpenOk.
  if (/NOT[-_]ALLOWED|Expected ConnectionOpenOk; got <ConnectionClose/.test(message)) {
    return new BrokerError(
      'vhost_not_accessible',
      `Vhost "${vhost}" on Broker Profile "${profile.name}" does not exist, or user "${credentials.brokerUser}" has no permissions on it.`,
    );
  }
  return connectionFailed(profile, 'the AMQP port', profile.amqpUrl, err);
}
