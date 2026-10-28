// Pure queue-list logic (no I/O): which queues are dead-letter queues, the
// order they are listed in, search, and Checkout availability by queue type.
import type { CheckoutQueueType } from '../../shared/checkout.js';
import type { CheckoutAvailability } from '../../shared/queues.js';

export type { CheckoutAvailability, CheckoutQueueType };

/**
 * Glob match on a whole queue name: `*` matches any run of characters
 * (dots included), `?` matches exactly one. Everything else is literal.
 */
export function matchesQueueFilter(name: string, pattern: string): boolean {
  const source = pattern
    .split('')
    .map((ch) => (ch === '*' ? '.*' : ch === '?' ? '.' : ch.replace(/[.+^${}()|[\]\\]/g, '\\$&')))
    .join('');
  return new RegExp(`^${source}$`).test(name);
}

/** What deadLetterSources needs to know about a queue. */
export interface DeadLetterSettings {
  name: string;
  arguments: Record<string, unknown>;
  /** Definition of the policies in effect. */
  effectivePolicy: Record<string, unknown>;
}

export interface Binding {
  source: string;
  destination: string;
  destinationType: 'queue' | 'exchange';
}

/**
 * For every queue that some queue dead-letters into, the names of those
 * source queues (sorted). A queue's dead-letter exchange comes from its
 * `x-dead-letter-exchange` argument or its policy's `dead-letter-exchange`;
 * when both are set, both count. Through a named exchange, every queue bound
 * to it (directly or through exchange-to-exchange bindings) counts, whatever
 * the routing key. Through the default exchange (""), the queue named by the
 * dead-letter routing key counts.
 */
export function deadLetterSources(queues: DeadLetterSettings[], bindings: Binding[]): Map<string, string[]> {
  const out = new Map<string, Set<string>>();
  const add = (target: string, source: string) => {
    if (!out.has(target)) out.set(target, new Set());
    out.get(target)!.add(source);
  };

  for (const q of queues) {
    const settings = [
      { exchange: q.arguments['x-dead-letter-exchange'], routingKey: q.arguments['x-dead-letter-routing-key'] },
      { exchange: q.effectivePolicy['dead-letter-exchange'], routingKey: q.effectivePolicy['dead-letter-routing-key'] },
    ];
    for (const { exchange, routingKey } of settings) {
      if (typeof exchange !== 'string') continue;
      if (exchange === '') {
        if (typeof routingKey === 'string' && routingKey !== '') add(routingKey, q.name);
        continue;
      }
      for (const target of queuesReachableFrom(exchange, bindings)) add(target, q.name);
    }
  }
  return new Map([...out].map(([target, sources]) => [target, [...sources].sort(compareNames)]));
}

function queuesReachableFrom(exchange: string, bindings: Binding[]): Set<string> {
  const queues = new Set<string>();
  const seen = new Set<string>([exchange]);
  const pending = [exchange];
  while (pending.length > 0) {
    const current = pending.pop()!;
    for (const b of bindings) {
      if (b.source !== current) continue;
      if (b.destinationType === 'queue') queues.add(b.destination);
      else if (!seen.has(b.destination)) {
        seen.add(b.destination);
        pending.push(b.destination);
      }
    }
  }
  return queues;
}

export interface ArrangeOptions {
  /** The Broker Profile's queue-name filter: matching queues are dead-letter queues. */
  defaultQueueFilter?: string | undefined;
  /** From deadLetterSources. */
  deadLetterSources: Map<string, string[]>;
  /** Keep only dead-letter queues. */
  onlyDeadLetterQueues?: boolean;
  /** Case-insensitive substring of the queue name. */
  search?: string | undefined;
}

export type Arranged<Q> = Q & {
  /** Matches the profile's queue-name filter, or other queues dead-letter into it. */
  deadLetterQueue: boolean;
  matchesDefaultFilter: boolean;
  /** Queues that dead-letter into this one, by name. */
  deadLetteredFrom: string[];
};

/** Orders queues for display: dead-letter queues first, then the rest, each group by name. */
export function arrangeQueues<Q extends { name: string }>(queues: Q[], options: ArrangeOptions): Array<Arranged<Q>> {
  const filter = options.defaultQueueFilter;
  const search = options.search?.trim().toLowerCase();
  return queues
    .map((q) => {
      const matchesDefaultFilter = filter ? matchesQueueFilter(q.name, filter) : false;
      const deadLetteredFrom = options.deadLetterSources.get(q.name) ?? [];
      return { ...q, deadLetterQueue: matchesDefaultFilter || deadLetteredFrom.length > 0, matchesDefaultFilter, deadLetteredFrom };
    })
    .filter((q) => !options.onlyDeadLetterQueues || q.deadLetterQueue)
    .filter((q) => !search || q.name.toLowerCase().includes(search))
    .sort((a, b) => (a.deadLetterQueue !== b.deadLetterQueue ? (a.deadLetterQueue ? -1 : 1) : compareNames(a.name, b.name)));
}

/** Orders names by code unit (as the broker lists them), not by locale. */
export function compareNames(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export function isCheckoutQueueType(queueType: string): queueType is CheckoutQueueType {
  return queueType === 'classic' || queueType === 'quorum';
}

/** `queueType` is the broker's own type name (any queue type, as the management API reports it). */
export function checkoutAvailability(queueType: string): CheckoutAvailability {
  return isCheckoutQueueType(queueType)
    ? { available: true }
    : { available: false, reason: notCheckoutableReason(queueType) };
}

/** Why a queue of a type other than classic or quorum can't be checked out. */
export function notCheckoutableReason(queueType: string): string {
  if (queueType === 'stream') {
    return 'Stream queues cannot be checked out: a stream keeps its Messages after they are read, so there is nothing to hold and settle one by one. Only classic and quorum queues can be triaged.';
  }
  return `Queues of type "${queueType}" cannot be checked out. Only classic and quorum queues can be triaged.`;
}
