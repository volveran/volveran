// Dead-letter set-up checks (pure, no I/O): set-ups where the broker silently
// loses Messages, read from management API data only (queues with their
// arguments and effective policies, exchanges and bindings). Each check is
// backed by a broker-facts test (docs/rabbitmq-behaviour.md, "Dead-letter
// set-up" and "Delivery counting").
//
// A check looks at one queue in its vhost and returns a warning or null. To
// add one: write it as a SetupCheck, add its warning to SetupWarning
// (src/shared/queues.ts) and list it in `checks`.
import type { SetupWarning, SetupWarningCounts, SetupWarningSeverity } from '../../shared/queues.js';

export type { SetupWarning, SetupWarningCounts };

/** Most severe first. */
const severities: SetupWarningSeverity[] = ['loses_messages', 'may_lose_messages'];

/** What the checks need to know about a listed queue. */
export interface CheckedQueue {
  name: string;
  /** The broker's queue type. */
  type: string;
  arguments: Record<string, unknown>;
  /** Definition of the policies in effect. */
  effectivePolicy: Record<string, unknown>;
  /** The effective delivery-limit from the management API; null when unlimited or unknown. */
  deliveryLimit: number | null;
  /** Matches the profile's queue-name filter, or other queues dead-letter into it (from arrangeQueues). */
  deadLetterQueue: boolean;
}

/** The rest of the vhost, as the checks see it. */
export interface VhostTopology {
  /** The named exchanges by name. The default exchange ("") always exists and is not listed. */
  exchanges: Map<string, { type: string; alternateExchange?: string }>;
  bindings: Array<{ source: string; destination: string; destinationType: 'queue' | 'exchange'; routingKey: string }>;
}

export type SetupCheck = (q: CheckedQueue, vhost: VhostTopology) => SetupWarning | null;

/** Where a queue dead-letters to, once arguments and policies are applied. */
export interface DeadLetterTarget {
  /** "" is the default exchange. */
  exchange: string;
  /** null when not set: Messages keep the routing keys they were published with. */
  routingKey: string | null;
}

/**
 * The queue's effective dead-letter exchange and routing key, or null when it
 * has none. A queue argument wins over the policy's key of the same meaning,
 * as the broker resolves them.
 */
export function effectiveDeadLetter(q: Pick<CheckedQueue, 'arguments' | 'effectivePolicy'>): DeadLetterTarget | null {
  const exchange = pick(q.arguments['x-dead-letter-exchange'], q.effectivePolicy['dead-letter-exchange']);
  if (exchange === null) return null;
  return { exchange, routingKey: pick(q.arguments['x-dead-letter-routing-key'], q.effectivePolicy['dead-letter-routing-key']) };
}

function pick(argument: unknown, policy: unknown): string | null {
  if (typeof argument === 'string') return argument;
  if (typeof policy === 'string') return policy;
  return null;
}

function exchangeExists(name: string, vhost: VhostTopology): boolean {
  return name === '' || vhost.exchanges.has(name);
}

/** The broker's default delivery-limit for quorum queues (RabbitMQ 4.0+). */
const DEFAULT_DELIVERY_LIMIT = 20;

/**
 * A quorum dead-letter queue with a delivery limit and no dead-letter exchange
 * that exists: a Message returned abnormally more often than the limit allows
 * is dropped by the broker.
 */
export const deliveryLimitCheck: SetupCheck = (q, vhost) => {
  if (!q.deadLetterQueue || q.type !== 'quorum') return null;
  const limit = q.deliveryLimit;
  if (limit === null || limit < 0) return null;
  const target = effectiveDeadLetter(q);
  if (target && exchangeExists(target.exchange, vhost)) return null;
  const which = limit === DEFAULT_DELIVERY_LIMIT ? `the default delivery-limit (${limit})` : `a delivery-limit of ${limit}`;
  const [dlx, fix] = target
    ? [`a dead-letter exchange that does not exist ("${target.exchange}")`, `declare the dead-letter exchange "${target.exchange}"`]
    : ['no dead-letter exchange', 'give the queue a dead-letter exchange'];
  return {
    code: 'messages_dropped_at_delivery_limit',
    severity: 'loses_messages',
    deliveryLimit: limit,
    message:
      `This quorum queue has ${which} and ${dlx}: a Message returned to it abnormally more than ${limit} times (a crash, a lost connection, a rejection) is dropped for good. ` +
      `Set delivery-limit = -1 (for example with a policy) to never drop, or ${fix}.`,
  };
};

/** The queue's effective dead-letter exchange does not exist: the broker drops what the queue dead-letters. */
export const deadLetterExchangeMissingCheck: SetupCheck = (q, vhost) => {
  const target = effectiveDeadLetter(q);
  if (!target || exchangeExists(target.exchange, vhost)) return null;
  return {
    code: 'dead_letter_exchange_missing',
    severity: 'loses_messages',
    deadLetterExchange: target.exchange,
    message:
      `This queue dead-letters to the exchange "${target.exchange}", which does not exist in this vhost: every Message it dead-letters (rejected, expired, over a length or delivery limit) is dropped for good. ` +
      `Declare the exchange "${target.exchange}" and bind a dead-letter queue to it, or point the queue's dead-letter-exchange at one that exists.`,
  };
};

/**
 * The queue's dead-letter exchange exists but routes what the queue
 * dead-letters to no queue, and has no alternate exchange: the broker drops
 * the Message. Without a dead-letter routing key, Messages keep the keys they
 * reached the queue with, so it warns only when none of those routes.
 */
export const deadLetterUnroutableCheck: SetupCheck = (q, vhost) => {
  const target = effectiveDeadLetter(q);
  // The default exchange is left out (it routes to the queue named by the key).
  if (!target || target.exchange === '' || !vhost.exchanges.has(target.exchange)) return null;
  const keys = target.routingKey === null ? receivedKeys(q.name, vhost) : [target.routingKey];
  if (keys === null || keys.some((key) => routes(target.exchange, key, vhost, new Set()))) return null;
  const x = `"${target.exchange}"`;
  const [what, fix] =
    target.routingKey === null
      ? [`without a dead-letter routing key, so Messages keep the routing keys it received (${keys.map((k) => `"${k}"`).join(', ')}), none of which a binding routes to a queue`, `Bind a queue to ${x} with one of those keys, or set a dead-letter routing key that one routes`]
      : [`with the routing key "${target.routingKey}", which no binding routes to a queue`, `Bind a queue to ${x} with "${target.routingKey}"`];
  return {
    code: 'dead_letter_unroutable',
    severity: 'loses_messages',
    deadLetterExchange: target.exchange,
    routingKey: target.routingKey,
    message:
      `This queue dead-letters to the exchange ${x} ${what}: every Message it dead-letters is dropped for good. ` +
      `${fix}, or give ${x} an alternate exchange.`,
  };
};

/**
 * The routing keys Messages can reach queue `name` with: its own name (the
 * default exchange) and the keys it is bound with. Null when they cannot be
 * known: a binding from an exchange that ignores keys (fanout, headers, a
 * plugin's type) or a topic binding with a wildcard.
 */
function receivedKeys(name: string, vhost: VhostTopology): string[] | null {
  const keys = new Set([name]);
  for (const b of vhost.bindings) {
    if (b.destinationType !== 'queue' || b.destination !== name || b.source === '') continue;
    const type = vhost.exchanges.get(b.source)?.type;
    if (type === 'direct' || (type === 'topic' && !/(^|\.)[*#](\.|$)/.test(b.routingKey))) keys.add(b.routingKey);
    else return null;
  }
  return [...keys].sort();
}

/**
 * Whether `exchange` routes `routingKey` to at least one queue, following
 * exchange-to-exchange bindings. An exchange whose routing cannot be decided
 * from bindings (headers or a plugin's type) counts as routing.
 */
function routes(exchange: string, routingKey: string, vhost: VhostTopology, seen: Set<string>): boolean {
  if (seen.has(exchange)) return false;
  seen.add(exchange);
  const x = vhost.exchanges.get(exchange);
  if (!x) return false;
  if (x.type !== 'direct' && x.type !== 'fanout' && x.type !== 'topic') return true;
  return vhost.bindings.some(
    (b) =>
      b.source === exchange &&
      matches(x.type, b.routingKey, routingKey) &&
      (b.destinationType === 'queue' || routes(b.destination, routingKey, vhost, seen)),
  );
}

/** Whether a binding with key `bindingKey` on an exchange of `type` matches `routingKey`. */
function matches(type: string, bindingKey: string, routingKey: string): boolean {
  if (type === 'fanout') return true;
  return bindingKey === routingKey;
}

/** Every check, in the order their warnings are listed within a severity. */
const checks: SetupCheck[] = [deliveryLimitCheck, deadLetterExchangeMissingCheck, deadLetterUnroutableCheck];

/** Every set-up warning that applies to `q`, most severe first. */
export function setupWarnings(q: CheckedQueue, vhost: VhostTopology): SetupWarning[] {
  const found = checks.map((check) => check(q, vhost)).filter((w): w is SetupWarning => w !== null);
  const rank = (w: SetupWarning) => severities.indexOf(w.severity);
  return found.sort((a, b) => rank(a) - rank(b));
}

/** The warnings of a whole vhost, counted by severity. */
export function countSetupWarnings(warnings: Iterable<SetupWarning[]>): SetupWarningCounts {
  const counts = Object.fromEntries(severities.map((s) => [s, 0])) as SetupWarningCounts;
  for (const list of warnings) for (const w of list) counts[w.severity]++;
  return counts;
}
