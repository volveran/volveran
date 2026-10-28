// Thin client over the RabbitMQ management HTTP API for one Broker Profile.
// Uses node:http/https directly so a profile's CA file can be trusted per
// request. Every failure becomes a BrokerError with a specific code and a
// message the Operator can act on. Management statistics lag the broker by
// a few seconds, so counts read here are approximate.
import http from 'node:http';
import https from 'node:https';
import tls from 'node:tls';
import type { BrokerCredentials } from './broker-credentials.js';
import { BrokerError, brokerPermissionDenied, connectionFailed } from './broker-error.js';
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
}

export interface ManagementBinding {
  /** Source exchange ("" is the default exchange). */
  source: string;
  destination: string;
  destinationType: 'queue' | 'exchange';
  routingKey: string;
}

export interface ManagementExchange {
  /** Never "" (the default exchange is not listed). */
  name: string;
  /** direct, fanout, topic, headers, or a plugin's type. */
  type: string;
  /** An internal exchange only receives from other exchanges: clients cannot publish to it. */
  internal: boolean;
  /** Where Messages it cannot route go, by argument or policy (the argument wins); null for none. */
  alternateExchange: string | null;
}

const REQUEST_TIMEOUT_MS = 5_000;

export class ManagementClient {
  /**
   * `credentials` is asked on every request (basic auth with the shared
   * account, or the Operator's token as a bearer token), so an expired token
   * answers `broker_token_expired` then.
   */
  constructor(
    private readonly profile: BrokerProfile,
    private readonly credentials: () => BrokerCredentials,
  ) {}

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

  /** The named exchanges of `vhost`, the default exchange left out. */
  async listExchanges(vhost: string): Promise<ManagementExchange[]> {
    const body = (await this.inVhost(vhost, `/api/exchanges/${encodeURIComponent(vhost)}?columns=name,type,internal,arguments,policy`)) as any[];
    // An exchange names its policy but not the policy's definition: read those only when needed.
    const policies = body.some((e) => typeof e.policy === 'string') ? await this.policyDefinitions(vhost) : new Map();
    return body.map((e) => toExchange(e, policies)).filter((e) => e.name !== '');
  }

  /** The definitions of the vhost's policies, by name (readable with the "management" tag). */
  private async policyDefinitions(vhost: string): Promise<Map<string, Record<string, unknown>>> {
    const body = (await this.inVhost(vhost, `/api/policies/${encodeURIComponent(vhost)}`)) as any[];
    return new Map(body.filter((p) => isRecord(p.definition)).map((p) => [String(p.name), p.definition]));
  }

  /** One exchange, or null when it does not exist. */
  async getExchange(vhost: string, exchange: string): Promise<ManagementExchange | null> {
    try {
      return toExchange(await this.request(`/api/exchanges/${encodeURIComponent(vhost)}/${encodeURIComponent(exchange)}`));
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
          `Vhost "${vhost}" on Broker Profile "${this.profile.name}" does not exist, or user "${this.credentials().brokerUser}" has no permissions on it.`,
        );
      }
      throw err;
    }
  }

  private async request(path: string): Promise<unknown> {
    const { profile } = this;
    const credentials = this.credentials();
    const url = new URL(profile.managementUrl + path);
    let res: { status: number; text: string };
    try {
      res = await get(url, { authorization: credentials.authorization, accept: 'application/json' }, profile.ca);
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
      if (credentials.kind === 'operatorToken') {
        throw brokerPermissionDenied(
          profile,
          credentials.brokerUser,
          { type: 'management', name: '' },
          'management',
          'Volverán reads queues through the management API: the token needs a scope like <resource_server_id>.tag:management.',
        );
      }
      throw new BrokerError(
        'not_management_user',
        `User "${credentials.brokerUser}" of Broker Profile "${profile.name}" may not use the management API (it needs the "management" tag or higher).`,
      );
    }
    if (res.status === 401) {
      throw new BrokerError(
        'authentication_failed',
        `The broker rejected the credentials of Broker Profile "${profile.name}" (${credentials.describe}).` +
          (credentials.kind === 'operatorToken' ? ' Check that the broker accepts the token\'s audience and signing key.' : ''),
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
  };
}

/** `policies` resolves the exchange's policy by name; without it, only an argument gives the alternate exchange. */
function toExchange(e: any, policies = new Map<string, Record<string, unknown>>()): ManagementExchange {
  const argument = isRecord(e.arguments) ? e.arguments['alternate-exchange'] : undefined;
  const policy = typeof e.policy === 'string' ? policies.get(e.policy)?.['alternate-exchange'] : undefined;
  return {
    name: String(e.name ?? ''),
    type: String(e.type ?? 'direct'),
    internal: e.internal === true,
    alternateExchange: typeof argument === 'string' ? argument : typeof policy === 'string' ? policy : null,
  };
}
