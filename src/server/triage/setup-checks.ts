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
  exchanges: Map<string, { type: string }>;
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

/** Every check, in the order their warnings are listed within a severity. */
const checks: SetupCheck[] = [deliveryLimitCheck, deadLetterExchangeMissingCheck];

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
