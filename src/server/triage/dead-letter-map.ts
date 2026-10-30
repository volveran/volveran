// The Dead-letter Map's graph (pure, no I/O), from one reading of a vhost's
// dead-letter set-up: only the edges the broker sends Messages along, and only
// the queues on them.
import type { DeadLetterMap, DeadLetterMapEdge, DeadLetterMapNode } from '../../shared/dead-letter-map.js';
import type { DeadLetterEdge } from './dead-letter-edges.js';
import { compareNames, isMassTransitErrorQueue } from './queue-list.js';
import type { VhostReading } from './vhost-reading.js';

const queueId = (name: string) => `queue:${name}`;
const exchangeId = (name: string) => `exchange:${name}`;

export function deadLetterMap(reading: Pick<VhostReading, 'queues' | 'edges'>): DeadLetterMap {
  const rows = new Map(reading.queues.map((q) => [q.name, q]));
  const routed = reading.edges.filter((e) => e.routes && (e.target.type !== 'queue' || rows.has(e.target.name)));

  const edges = new Map<string, DeadLetterMapEdge>();
  const add = (edge: DeadLetterMapEdge, source: string) => {
    const { sources: _sources, ...identity } = edge;
    const id = JSON.stringify(identity);
    const known = edges.get(id) ?? edge;
    edges.set(id, known);
    if (!known.sources.includes(source)) known.sources = [...known.sources, source].sort(compareNames);
  };
  for (const e of routed) {
    add({ kind: 'dead_letter', from: queueId(e.source), to: exchangeId(e.deadLetterExchange), routingKey: e.routingKey, sources: [] }, e.source);
    add(graphEdge(e), e.source);
  }
  const conventions = reading.queues.flatMap((q) => {
    const input = q.name.slice(0, -'_error'.length);
    return isMassTransitErrorQueue(q.name) && rows.has(input) ? [{ input, errorQueue: q.name }] : [];
  });
  for (const { input, errorQueue } of conventions) {
    add({ kind: 'convention', from: queueId(input), to: queueId(errorQueue), sources: [] }, input);
  }

  const nodes = new Map<string, DeadLetterMapNode>();
  const missing = new Set(routed.flatMap((e) => (e.target.type === 'drop' && e.target.reason === 'exchange_missing' ? [exchangeId(e.from)] : [])));
  for (const id of [...edges.values()].flatMap((e) => ('to' in e ? [e.from, e.to] : [e.from]))) {
    if (nodes.has(id)) continue;
    if (id.startsWith('queue:')) {
      const row = rows.get(id.slice('queue:'.length))!;
      nodes.set(id, { id, kind: 'queue', name: row.name, type: row.type, approximateMessages: row.approximateMessages, setupWarnings: row.setupWarnings, inCycle: false });
    } else {
      nodes.set(id, { id, kind: 'exchange', name: id.slice('exchange:'.length), missing: missing.has(id), inCycle: false });
    }
  }

  const cycles = findCycles(routed, conventions);
  for (const id of cycles.flat()) nodes.get(id)!.inCycle = true;

  return { nodes: [...nodes.values()].sort((a, b) => compareNames(a.id, b.id)), edges: [...edges.values()], cycles };
}

/**
 * Looks for cycles among the queues, each edge going from a queue to where its
 * own Messages reach. Not among the graph's nodes: two queues sharing an
 * exchange look like a loop there though their keys send Messages onward, and
 * exchanges bound to each other never give a queue a Message back.
 */
function findCycles(routed: DeadLetterEdge[], conventions: Array<{ input: string; errorQueue: string }>): string[][] {
  const reaches = new Map<string, Set<string>>();
  const link = (from: string, to: string) => {
    if (!reaches.has(from)) reaches.set(from, new Set());
    reaches.get(from)!.add(to);
  };
  for (const e of routed) if (e.target.type === 'queue') link(e.source, e.target.name);
  for (const { input, errorQueue } of conventions) link(input, errorQueue);

  return stronglyConnected(reaches)
    .filter((group) => group.length > 1 || reaches.get(group[0]!)?.has(group[0]!))
    .map((group) => [...exchangesBetween(group, routed), ...group.map(queueId)].sort(compareNames))
    .sort((a, b) => compareNames(a[0]!, b[0]!));
}

/** The exchanges a queue of `group` sends its Messages through to another queue of `group`. */
function exchangesBetween(group: string[], routed: DeadLetterEdge[]): Set<string> {
  const between = new Set<string>();
  for (const source of group) {
    const hops = routed.filter((e) => e.source === source);
    const onTheWay = new Set(hops.filter((e) => e.target.type === 'queue' && group.includes(e.target.name)).map((e) => e.from));
    let before = 0;
    while (onTheWay.size !== before) {
      before = onTheWay.size;
      for (const e of hops) if (e.target.type === 'exchange' && onTheWay.has(e.target.name)) onTheWay.add(e.from);
    }
    for (const name of onTheWay) between.add(exchangeId(name));
  }
  return between;
}

/** Tarjan's algorithm: the groups of queues that can each reach all the others. */
function stronglyConnected(reaches: Map<string, Set<string>>): string[][] {
  const order = new Map<string, number>();
  const low = new Map<string, number>();
  const stack: string[] = [];
  const onStack = new Set<string>();
  const groups: string[][] = [];
  const visit = (queue: string) => {
    order.set(queue, order.size);
    low.set(queue, order.get(queue)!);
    stack.push(queue);
    onStack.add(queue);
    for (const next of reaches.get(queue) ?? []) {
      if (!order.has(next)) {
        visit(next);
        low.set(queue, Math.min(low.get(queue)!, low.get(next)!));
      } else if (onStack.has(next)) {
        low.set(queue, Math.min(low.get(queue)!, order.get(next)!));
      }
    }
    if (low.get(queue) !== order.get(queue)) return;
    const group: string[] = [];
    let member: string;
    do {
      member = stack.pop()!;
      onStack.delete(member);
      group.push(member);
    } while (member !== queue);
    groups.push(group);
  };
  for (const queue of reaches.keys()) if (!order.has(queue)) visit(queue);
  return groups;
}

/** The hop of a Dead-letter Edge as a graph edge, for now without its sources. */
function graphEdge(e: DeadLetterEdge): DeadLetterMapEdge {
  const from = exchangeId(e.from);
  const { target } = e;
  if (target.type === 'drop') return { kind: 'drop', from, reason: target.reason, sources: [] };
  if (target.type === 'unresolved') return { kind: 'unresolved', from, sources: [] };
  const to = target.type === 'queue' ? queueId(target.name) : exchangeId(target.name);
  if (e.via === 'binding') return { kind: 'binding', from, to, bindingKey: e.bindingKey ?? '', sources: [] };
  return { kind: e.via === 'alternate_exchange' ? 'alternate_exchange' : 'default_exchange', from, to, sources: [] };
}
