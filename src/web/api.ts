// Thin typed client over Volverán's HTTP JSON API. The types mirror the
// server's JSON by hand (src/server/server.ts); keep them in sync.
import { product } from '../shared/product.js';

export interface Session {
  mode: 'solo';
  /** Who is acting: in Solo Mode, the configured name. */
  operator: string;
  /** The Operator's active Checkout, if any. */
  checkoutId: string | null;
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
  /** Who holds the queue in a Checkout, from any Volverán instance; null when nobody does. */
  checkedOutBy: CheckoutHolder | null;
}

export interface CheckoutHolder {
  operator: string;
  since: string;
}

export interface DeliveryBudget {
  remaining: number;
  warning: string | null;
}

export interface MessageSummary {
  handle: number;
  messageId: string | null;
  routingKey: string;
  timestamp: string | null;
  deadLetterReason: string | null;
  originalQueue: string | null;
  size: number;
  deliveryBudget: DeliveryBudget | null;
}

export interface XDeathEntry {
  queue: string | null;
  reason: string | null;
  count: number | null;
  time: string | null;
  exchange: string | null;
  routingKeys: string[];
  originalExpiration: string | null;
}

export type RenderedBody =
  | { kind: 'json'; size: number; text: string }
  | { kind: 'text'; size: number; text: string }
  | { kind: 'binary'; size: number; hex: string; base64: string };

export interface MessageDetail extends MessageSummary {
  exchange: string;
  redelivered: boolean;
  deliveryCount: number | null;
  deliveryLimit: number | null;
  properties: Record<string, unknown>;
  headers: Record<string, unknown>;
  xDeath: XDeathEntry[];
  body: RenderedBody;
}

export interface Checkout {
  id: string;
  profile: string;
  protectedProfile: boolean;
  vhost: string;
  queue: string;
  queueType: 'classic' | 'quorum';
  operator: string;
  startedAt: string;
  status: 'active' | 'ended' | 'lost';
  lostReason: string | null;
  endReason: 'operator' | 'shutdown' | null;
  readyAtStart: number;
  heldCount: number;
  heldBytes: number;
  limits: { maxMessages: number; maxBytes: number };
  limitedBy: 'messages' | 'bytes' | null;
  deliveryLimit: number | null;
  messages: MessageSummary[];
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

async function getJson<T>(path: string, method = 'GET'): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, { method, headers: { accept: 'application/json' } });
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
  startCheckout: (profile: string, vhost: string, queue: string) =>
    getJson<{ checkout: Checkout }>(
      `/api/profiles/${segment(profile)}/vhosts/${segment(vhost)}/queues/${segment(queue)}/checkouts`,
      'POST',
    ).then((b) => b.checkout),
  checkout: (id: string) => getJson<{ checkout: Checkout }>(`/api/checkouts/${segment(id)}`).then((b) => b.checkout),
  message: (id: string, handle: number) =>
    getJson<{ message: MessageDetail }>(`/api/checkouts/${segment(id)}/messages/${handle}`).then((b) => b.message),
  endCheckout: (id: string) =>
    getJson<{ checkout: Checkout }>(`/api/checkouts/${segment(id)}`, 'DELETE').then((b) => b.checkout),
};
