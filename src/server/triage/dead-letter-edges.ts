// Where each queue of a vhost dead-letters to (pure, no I/O): one edge per hop,
// from the queue's dead-letter exchange through exchange-to-exchange bindings
// and alternate exchanges to each queue, with the key-aware routing of the
// set-up checks (setup-checks.ts).
import { effectiveDeadLetter, keyMatchesBinding, receivedKeys, type DeadLetterTarget, type VhostTopology } from './setup-checks.js';

/** Where a hop goes. */
export type DeadLetterEdgeTarget =
  | { type: 'queue' | 'exchange'; name: string }
  /** A loss: the exchange does not exist, or it routes the routing key to no queue. */
  | { type: 'drop'; reason: 'exchange_missing' | 'routes_nowhere' }
  /** Cannot be told from the set-up: a kept routing key through the default exchange, or a headers or plugin exchange with no bindings. */
  | { type: 'unresolved' };

/** One hop of a queue's dead-letter path. */
export interface DeadLetterEdge {
  /** The queue that dead-letters. */
  source: string;
  /** Its dead-letter exchange; "" is the default exchange. */
  deadLetterExchange: string;
  /** Its dead-letter routing key; null when Messages keep their own. */
  routingKey: string | null;
  /** The exchange this hop leaves. */
  from: string;
  /** null for a drop or an unresolved target. */
  via: 'binding' | 'alternate_exchange' | 'default_exchange' | null;
  /** The binding's routing key; null when the hop is not a binding. */
  bindingKey: string | null;
  target: DeadLetterEdgeTarget;
  /**
   * Whether the broker sends Messages along this hop. False for a binding the
   * routing key does not match, or a dead-letter exchange the queue's argument
   * overrides: those exist only for `countsAsDeadLetteredFrom`. Anything that
   * follows the Messages (the Dead-letter Map) keeps only the `routes` edges.
   */
  routes: boolean;
  /**
   * Whether the target queue's `deadLetteredFrom` names the source. That list
   * is wider than routing in one way and narrower in another: it counts every
   * queue bound to an exchange whatever the key, and to each exchange set by
   * an argument or a policy, but not what an alternate exchange catches.
   */
  countsAsDeadLetteredFrom: boolean;
}

/** What the edges need to know about a queue. */
export interface DeadLetterSettings {
  name: string;
  arguments: Record<string, unknown>;
  /** Definition of the policies in effect. */
  effectivePolicy: Record<string, unknown>;
}

/** Every dead-letter edge of the vhost, queue by queue. */
export function deadLetterEdges(queues: DeadLetterSettings[], vhost: VhostTopology): DeadLetterEdge[] {
  const queueNames = new Set(queues.map((q) => q.name));
  return queues.flatMap((q) => {
    const edges = new Map<string, DeadLetterEdge>();
    const target = effectiveDeadLetter(q);
    if (target) {
      for (const hop of routedHops(q.name, target, vhost, queueNames)) {
        edges.set(hopId(hop, target.exchange), {
          source: q.name,
          deadLetterExchange: target.exchange,
          routingKey: target.routingKey,
          ...hop,
          routes: true,
          countsAsDeadLetteredFrom: false,
        });
      }
    }
    for (const edge of listedEdges(q, vhost.bindings)) {
      const id = hopId(edge, edge.deadLetterExchange);
      const routed = edges.get(id);
      if (routed) routed.countsAsDeadLetteredFrom = true;
      else edges.set(id, edge);
    }
    return [...edges.values()];
  });
}

/**
 * The edges `deadLetteredFrom` counts, from a queue's settings as declared:
 * both an argument's and a policy's, and every binding whatever its key.
 * Through the default exchange, the queue named by a non-empty routing key.
 */
export function listedEdges(q: DeadLetterSettings, bindings: ListedBinding[]): DeadLetterEdge[] {
  const declared = [
    { exchange: q.arguments['x-dead-letter-exchange'], routingKey: q.arguments['x-dead-letter-routing-key'] },
    { exchange: q.effectivePolicy['dead-letter-exchange'], routingKey: q.effectivePolicy['dead-letter-routing-key'] },
  ];
  const edges: DeadLetterEdge[] = [];
  for (const { exchange, routingKey } of declared) {
    if (typeof exchange !== 'string') continue;
    const key = typeof routingKey === 'string' ? routingKey : null;
    const add = (hop: Hop) => edges.push({ source: q.name, deadLetterExchange: exchange, routingKey: key, ...hop, routes: false, countsAsDeadLetteredFrom: true });
    if (exchange === '') {
      if (key) add({ from: '', via: 'default_exchange', bindingKey: null, target: { type: 'queue', name: key } });
      continue;
    }
    const seen = new Set([exchange]);
    const pending = [exchange];
    while (pending.length > 0) {
      const current = pending.pop()!;
      for (const b of bindings) {
        if (b.source !== current) continue;
        add({ from: current, via: 'binding', bindingKey: b.routingKey ?? '', target: { type: b.destinationType, name: b.destination } });
        if (b.destinationType === 'exchange' && !seen.has(b.destination)) {
          seen.add(b.destination);
          pending.push(b.destination);
        }
      }
    }
  }
  return edges;
}

/** A binding as `listedEdges` needs it. */
export interface ListedBinding {
  source: string;
  destination: string;
  destinationType: 'queue' | 'exchange';
  routingKey?: string;
}

type Hop = Pick<DeadLetterEdge, 'from' | 'via' | 'bindingKey' | 'target'>;

function hopId(hop: Hop, deadLetterExchange: string): string {
  return JSON.stringify([deadLetterExchange, hop.from, hop.via, hop.bindingKey, hop.target]);
}

/** The hops the broker sends the queue's dead-lettered Messages along. */
function routedHops(queue: string, target: DeadLetterTarget, vhost: VhostTopology, queueNames: Set<string>): Hop[] {
  const { exchange, routingKey } = target;
  if (exchange === '') {
    if (routingKey === null) return [{ from: '', via: 'default_exchange', bindingKey: null, target: { type: 'unresolved' } }];
    return queueNames.has(routingKey)
      ? [{ from: '', via: 'default_exchange', bindingKey: null, target: { type: 'queue', name: routingKey } }]
      : [drop('', 'routes_nowhere')];
  }
  // A null key: what the Messages carry cannot be known, so every binding may carry them.
  const keys: Array<string | null> = routingKey === null ? (receivedKeys(queue, vhost) ?? [null]) : [routingKey];
  const walks = keys.map((key) => {
    const hops: Hop[] = [];
    const routed = walk(exchange, key, vhost, new Set(), hops);
    if (!routed && !hops.some((h) => h.target.type === 'drop')) hops.push(drop(exchange, 'routes_nowhere'));
    return { hops, routed };
  });
  // As the unroutable check: with kept keys, a loss only when none of them routes.
  const anyRouted = walks.some((w) => w.routed);
  return walks.flatMap((w) => (anyRouted ? w.hops.filter((h) => h.target.type !== 'drop') : w.hops));
}

/** Adds the hops `key` takes from `exchange` to `hops`; whether it reaches a queue. */
function walk(exchange: string, key: string | null, vhost: VhostTopology, seen: Set<string>, hops: Hop[]): boolean {
  if (seen.has(exchange)) return false;
  seen.add(exchange);
  const x = vhost.exchanges.get(exchange);
  if (!x) {
    hops.push(drop(exchange, 'exchange_missing'));
    return false;
  }
  // Headers or a plugin's type: bindings alone do not decide, so each counts and the exchange is trusted to route.
  const decidable = x.type === 'direct' || x.type === 'fanout' || x.type === 'topic';
  const before = hops.length;
  let routed = !decidable;
  for (const b of vhost.bindings) {
    if (b.source !== exchange) continue;
    if (key !== null && decidable && !keyMatchesBinding(x.type, b.routingKey, key)) continue;
    hops.push({ from: exchange, via: 'binding', bindingKey: b.routingKey, target: { type: b.destinationType, name: b.destination } });
    if (b.destinationType === 'queue' || walk(b.destination, key, vhost, seen, hops)) routed = true;
  }
  if (!decidable && hops.length === before) hops.push({ from: exchange, via: null, bindingKey: null, target: { type: 'unresolved' } });
  // What it cannot route goes to its alternate exchange; with an unknown key, some may.
  if (x.alternateExchange && (!routed || key === null)) {
    hops.push({ from: exchange, via: 'alternate_exchange', bindingKey: null, target: { type: 'exchange', name: x.alternateExchange } });
    if (walk(x.alternateExchange, key, vhost, seen, hops)) routed = true;
  }
  if (!routed && hops.length === before) hops.push(drop(exchange, 'routes_nowhere'));
  return routed;
}

function drop(from: string, reason: 'exchange_missing' | 'routes_nowhere'): Hop {
  return { from, via: null, bindingKey: null, target: { type: 'drop', reason } };
}
