// Thin typed client over Volverán's HTTP JSON API. The types mirror the
// server's JSON by hand (src/server/server.ts); keep them in sync.
import { product } from '../shared/product.js';

export interface Session {
  mode: 'solo';
  /** Who is acting: in Solo Mode, the configured name. */
  operator: string;
}

export interface Profile {
  name: string;
  username: string;
  managementUrl: string;
  amqpUrl: string;
  passwordEnv: string;
  /** Whether the password variable is set; a profile without one cannot connect. */
  passwordSet: boolean;
  vhosts: 'all' | string[];
  defaultQueueFilter: string | null;
  protected: boolean;
}

/** A dead-letter set-up that silently loses Messages (src/server/triage/queue-list.ts). */
export interface SetupWarning {
  code: 'messages_dropped_at_delivery_limit';
  deliveryLimit: number;
  message: string;
}

export type CheckoutAvailability = { available: true } | { available: false; reason: string };

export interface Queue {
  name: string;
  type: string;
  /** From management statistics, which lag the broker by a few seconds. */
  approximateMessages: number;
  consumers: number;
  /** Matches the profile's queue-name filter, or other queues dead-letter into it. */
  deadLetterQueue: boolean;
  matchesDefaultFilter: boolean;
  deadLetteredFrom: string[];
  checkout: CheckoutAvailability;
  setupWarning: SetupWarning | null;
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

async function getJson<T>(path: string): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, { headers: { accept: 'application/json' } });
  } catch (err) {
    throw new ApiError(0, 'app_unreachable', `Cannot reach ${product.name}: ${(err as Error).message}`);
  }
  const body = await res.json().catch(() => undefined);
  if (!res.ok) {
    const { code, message, ...details } = (body?.error ?? {}) as { code?: string; message?: string };
    throw new ApiError(res.status, code ?? 'http_error', message ?? `Request failed with ${res.status}`, details);
  }
  return body as T;
}

const segment = encodeURIComponent;

export const api = {
  session: () => getJson<Session>('/api/session'),
  profiles: () => getJson<{ profiles: Profile[] }>('/api/profiles').then((b) => b.profiles),
  vhosts: (profile: string) =>
    getJson<{ vhosts: Array<{ name: string }> }>(`/api/profiles/${segment(profile)}/vhosts`).then((b) =>
      b.vhosts.map((v) => v.name),
    ),
  queues: (profile: string, vhost: string, opts: { search: string; onlyDeadLetterQueues: boolean }) => {
    const params = new URLSearchParams();
    if (opts.search.trim()) params.set('search', opts.search.trim());
    if (opts.onlyDeadLetterQueues) params.set('onlyDeadLetterQueues', 'true');
    const qs = params.size > 0 ? `?${params}` : '';
    return getJson<{ queues: Queue[] }>(`/api/profiles/${segment(profile)}/vhosts/${segment(vhost)}/queues${qs}`).then(
      (b) => b.queues,
    );
  },
};
