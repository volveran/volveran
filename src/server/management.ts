// Thin client over the RabbitMQ management HTTP API for one Broker Profile.
// Uses node:http/https directly so a profile's CA file can be trusted per
// request. Every failure becomes a BrokerError with a specific code and a
// message the Operator can act on. Management statistics lag the broker by
// a few seconds, so counts read here are approximate.
import http from 'node:http';
import https from 'node:https';
import tls from 'node:tls';
import { BrokerError, connectionFailed, requirePassword } from './broker-error.js';
import { isRecord } from './is-record.js';
import type { BrokerProfile } from './profiles.js';

export interface ManagementQueue {
  name: string;
  /** The broker's queue type: classic, quorum, stream, or a plugin's type. */
  type: string;
  /** Ready plus unacknowledged Messages, from management statistics (lags). */
  messages: number;
  consumers: number;
  arguments: Record<string, unknown>;
  /** Definition of the policies in effect (operator policy merged in), {} for none. */
  effectivePolicy: Record<string, unknown>;
  /** Effective delivery-limit of a quorum queue (arguments and policies applied); null for other types or unlimited. */
  deliveryLimit: number | null;
  /** Total body bytes of the ready Messages, from management statistics (lags); null when not reported. */
  messageBytesReady: number | null;
}

export interface ManagementBinding {
  /** Source exchange ("" is the default exchange). */
  source: string;
  destination: string;
  destinationType: 'queue' | 'exchange';
  routingKey: string;
}

const REQUEST_TIMEOUT_MS = 5_000;

export class ManagementClient {
  constructor(private readonly profile: BrokerProfile) {}

  async listVhosts(): Promise<string[]> {
    const body = (await this.request('/api/vhosts?columns=name')) as Array<{ name: string }>;
    return body.map((v) => v.name).sort();
  }

  async listQueues(vhost: string): Promise<ManagementQueue[]> {
    const columns = 'name,type,messages,consumers,arguments,effective_policy_definition,delivery_limit';
    const body = await this.inVhost(vhost, `/api/queues/${encodeURIComponent(vhost)}?columns=${columns}`);
    return (body as any[]).map(toQueue);
  }

  /** One queue, or null when it does not exist. */
  async getQueue(vhost: string, queue: string): Promise<ManagementQueue | null> {
    try {
      return toQueue(await this.request(`/api/queues/${encodeURIComponent(vhost)}/${encodeURIComponent(queue)}`));
    } catch (err) {
      if (err instanceof NotFound) return null;
      throw err;
    }
  }

  async listBindings(vhost: string): Promise<ManagementBinding[]> {
    const body = await this.inVhost(vhost, `/api/bindings/${encodeURIComponent(vhost)}`);
    return (body as any[]).map((b) => ({
      source: String(b.source ?? ''),
      destination: String(b.destination ?? ''),
      destinationType: b.destination_type === 'exchange' ? 'exchange' : 'queue',
      routingKey: String(b.routing_key ?? ''),
    }));
  }

  /** A vhost-scoped request; 404 means the vhost is missing or the user has no permissions on it. */
  private async inVhost(vhost: string, path: string): Promise<unknown> {
    try {
      return await this.request(path);
    } catch (err) {
      if (err instanceof NotFound) {
        throw new BrokerError(
          'vhost_not_accessible',
          `Vhost "${vhost}" on Broker Profile "${this.profile.name}" does not exist, or user "${this.profile.username}" has no permissions on it.`,
        );
      }
      throw err;
    }
  }

  private async request(path: string): Promise<unknown> {
    const { profile } = this;
    const auth = Buffer.from(`${profile.username}:${requirePassword(profile)}`).toString('base64');
    const url = new URL(profile.managementUrl + path);
    let res: { status: number; text: string };
    try {
      res = await get(url, { authorization: `Basic ${auth}`, accept: 'application/json' }, profile.ca);
    } catch (err) {
      throw connectionFailed(profile, 'the management API', profile.managementUrl, err);
    }

    if (res.status >= 200 && res.status < 300) return JSON.parse(res.text);

    let detail: { error?: string; reason?: string } = {};
    try {
      detail = JSON.parse(res.text);
    } catch {
      // not JSON: no detail
    }
    if (res.status === 401 && /not management user/i.test(detail.reason ?? '')) {
      throw new BrokerError(
        'not_management_user',
        `User "${profile.username}" of Broker Profile "${profile.name}" may not use the management API (it needs the "management" tag or higher).`,
      );
    }
    if (res.status === 401) {
      throw new BrokerError(
        'authentication_failed',
        `The broker rejected the credentials of Broker Profile "${profile.name}" (user "${profile.username}", password from ${profile.passwordEnv}).`,
      );
    }
    if (res.status === 404) throw new NotFound();
    throw new BrokerError(
      'broker_error',
      `The management API of Broker Profile "${profile.name}" answered ${res.status} ${detail.reason ?? ''}`.trim() + '.',
    );
  }
}

class NotFound extends Error {}

/** GET over http or https; `ca` is trusted on top of Node's default CAs. */
function get(url: URL, headers: Record<string, string>, ca: Buffer | undefined): Promise<{ status: number; text: string }> {
  return new Promise((resolve, reject) => {
    const options: https.RequestOptions = { headers, method: 'GET' };
    if (ca) options.ca = [...tls.rootCertificates, ca.toString('utf8')];
    const send = url.protocol === 'https:' ? https.request : http.request;
    const req = send(url, options, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, text: Buffer.concat(chunks).toString('utf8') }));
      res.on('error', reject);
    });
    req.setTimeout(REQUEST_TIMEOUT_MS, () =>
      req.destroy(Object.assign(new Error(`no answer within ${REQUEST_TIMEOUT_MS / 1000} s`), { code: 'ETIMEDOUT' })),
    );
    req.on('error', reject);
    req.end();
  });
}

function toQueue(q: any): ManagementQueue {
  return {
    name: String(q.name),
    type: String(q.type ?? 'classic'),
    messages: Number(q.messages ?? 0),
    consumers: Number(q.consumers ?? 0),
    arguments: isRecord(q.arguments) ? q.arguments : {},
    // The API sends [] rather than {} when no policy applies.
    effectivePolicy: isRecord(q.effective_policy_definition) ? q.effective_policy_definition : {},
    deliveryLimit: typeof q.delivery_limit === 'number' && Number.isFinite(q.delivery_limit) ? q.delivery_limit : null,
    messageBytesReady: typeof q.message_bytes_ready === 'number' ? q.message_bytes_ready : null,
  };
}
