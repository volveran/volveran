// Pure queue-list logic (no I/O): which queues are dead-letter queues, the
// order they are listed in, search, and Checkout availability by queue type.
import type { CheckoutQueueType } from '../../shared/checkout.js';
import type { CheckoutAvailability } from '../../shared/queues.js';
import { listedEdges, type DeadLetterEdge, type DeadLetterSettings, type ListedBinding } from './dead-letter-edges.js';

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

export type { DeadLetterSettings };
export type Binding = ListedBinding;

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
  return sourcesFromEdges(queues.flatMap((q) => listedEdges(q, bindings)));
}

/** The source queues of each queue, sorted, from the edges that count towards `deadLetteredFrom`. */
export function sourcesFromEdges(edges: DeadLetterEdge[]): Map<string, string[]> {
  const out = new Map<string, Set<string>>();
  for (const { countsAsDeadLetteredFrom, target, source } of edges) {
    if (!countsAsDeadLetteredFrom || target.type !== 'queue') continue;
    if (!out.has(target.name)) out.set(target.name, new Set());
    out.get(target.name)!.add(source);
  }
  return new Map([...out].map(([target, sources]) => [target, [...sources].sort(compareNames)]));
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
  /** Matches the profile's queue-name filter, other queues dead-letter into it, or it is a MassTransit `_error` queue. */
  deadLetterQueue: boolean;
  matchesDefaultFilter: boolean;
  /** Queues that dead-letter into this one, by name. */
  deadLetteredFrom: string[];
};

/** Orders queues for display: dead-letter queues first, then the rest, each group by name. */
export function arrangeQueues<Q extends { name: string }>(queues: Q[], options: ArrangeOptions): Array<Arranged<Q>> {
  const filter = options.defaultQueueFilter;
  const arranged = queues.map((q) => {
    const matchesDefaultFilter = filter ? matchesQueueFilter(q.name, filter) : false;
    const deadLetteredFrom = options.deadLetterSources.get(q.name) ?? [];
    const deadLetterQueue = matchesDefaultFilter || deadLetteredFrom.length > 0 || isMassTransitErrorQueue(q.name);
    return { ...q, deadLetterQueue, matchesDefaultFilter, deadLetteredFrom };
  });
  return narrowQueues(arranged, options).sort((a, b) =>
    a.deadLetterQueue !== b.deadLetterQueue ? (a.deadLetterQueue ? -1 : 1) : compareNames(a.name, b.name),
  );
}

/** The queues the search and the dead-letter queue filter leave listed. */
export function narrowQueues<Q extends { name: string; deadLetterQueue: boolean }>(
  queues: Q[],
  options: Pick<ArrangeOptions, 'onlyDeadLetterQueues' | 'search'>,
): Q[] {
  const search = options.search?.trim().toLowerCase();
  return queues
    .filter((q) => !options.onlyDeadLetterQueues || q.deadLetterQueue)
    .filter((q) => !search || q.name.toLowerCase().includes(search));
}

/**
 * MassTransit moves Messages a consumer gave up on to `<queue>_error` itself,
 * without broker dead-lettering. (Its `_skipped` queues hold Messages no
 * consumer handles; they are not dead-letter queues.)
 */
export function isMassTransitErrorQueue(name: string): boolean {
  return name.endsWith('_error');
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
