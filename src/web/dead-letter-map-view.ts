// The pure logic of the Dead-letter Map (DeadLetterMapView.tsx): where each
// node goes in the diagram, how edges get there, the search and the text listing.
import type { DeadLetterMap, DeadLetterMapEdge, DeadLetterMapExchange, DeadLetterMapQueue } from '../shared/dead-letter-map.js';

type DrawnKind = DeadLetterMapEdge['kind'];
/** Nodes the API has no node for: where a `drop` or `unresolved` edge ends. */
export type LossNode = { id: string; kind: 'loss'; reason: 'exchange_missing' | 'routes_nowhere' };
export type UnresolvedNode = { id: string; kind: 'unresolved' };
export type PlacedNode = (DeadLetterMapQueue | DeadLetterMapExchange | LossNode | UnresolvedNode) & { column: number; row: number };

export interface PlacedEdge {
  from: string;
  to: string;
  kind: DrawnKind;
  labels: string[];
  /** Goes against the columns, because the graph loops here. Not always a cycle: see `inCycle`. */
  back: boolean;
  /** Both ends are in one of the map's cycles. */
  inCycle: boolean;
}

export interface MapLayout {
  nodes: PlacedNode[];
  edges: PlacedEdge[];
  columns: number;
  rows: number;
}

type GraphNode = LossNode | UnresolvedNode | DeadLetterMapQueue | DeadLetterMapExchange;

/** Where an edge ends, with `drop` and `unresolved` ending on a node of their own. */
function endOf(edge: DeadLetterMapEdge): string {
  const exchange = edge.from.slice('exchange:'.length);
  if (edge.kind === 'drop') return `loss:${exchange}`;
  if (edge.kind === 'unresolved') return `unresolved:${exchange}`;
  return edge.to;
}

function labelOf(edge: DeadLetterMapEdge): string | null {
  switch (edge.kind) {
    case 'dead_letter':
      return edge.routingKey === null ? "Message's own routing key" : `routing key ${edge.routingKey}`;
    case 'binding':
      return edge.bindingKey === '' ? null : `key ${edge.bindingKey}`;
    case 'alternate_exchange':
      return 'alternate exchange';
    case 'default_exchange':
      return 'queue named by the key';
    case 'drop':
      return edge.reason === 'exchange_missing' ? 'exchange does not exist' : 'routes to no queue';
    case 'convention':
      return 'by convention';
    case 'unresolved':
      return null;
  }
}

/**
 * Columns by distance from the queues nothing dead-letters into, the longest
 * way there, so every edge but a loop's goes right. A loop is cut where a walk
 * from a queue comes back on itself; that edge is drawn going back.
 */
export function layoutMap(map: DeadLetterMap): MapLayout {
  const nodes = new Map<string, GraphNode>(map.nodes.map((n) => [n.id, n]));
  const merged = new Map<string, PlacedEdge>();
  for (const edge of map.edges) {
    const to = endOf(edge);
    if (!nodes.has(to) && edge.kind === 'drop') nodes.set(to, { id: to, kind: 'loss', reason: edge.reason });
    if (!nodes.has(to) && edge.kind === 'unresolved') nodes.set(to, { id: to, kind: 'unresolved' });
    const key = JSON.stringify([edge.from, to, edge.kind]);
    const placed = merged.get(key) ?? { from: edge.from, to, kind: edge.kind, labels: [], back: false, inCycle: map.cycles.some((c) => c.includes(edge.from) && c.includes(to)) };
    merged.set(key, placed);
    const label = labelOf(edge);
    if (label !== null && !placed.labels.includes(label)) placed.labels.push(label);
  }
  const edges = [...merged.values()];

  const outgoing = new Map<string, PlacedEdge[]>();
  const incoming = new Map<string, PlacedEdge[]>();
  for (const e of edges) {
    outgoing.set(e.from, [...(outgoing.get(e.from) ?? []), e]);
    incoming.set(e.to, [...(incoming.get(e.to) ?? []), e]);
  }

  // Walk from the queues nothing leads to, then from any queue left (a loop has no start).
  const queues = [...nodes.values()].filter((n) => n.kind === 'queue').map((n) => n.id).sort();
  const starts = [...queues.filter((id) => !incoming.has(id)), ...queues.filter((id) => incoming.has(id)), ...nodes.keys()];
  const state = new Map<string, 'walking' | 'done'>();
  const finished: string[] = [];
  const walk = (id: string) => {
    state.set(id, 'walking');
    for (const e of outgoing.get(id) ?? []) {
      const seen = state.get(e.to);
      if (seen === 'walking') e.back = true;
      else if (seen === undefined) walk(e.to);
    }
    state.set(id, 'done');
    finished.push(id);
  };
  for (const id of starts) if (!state.has(id)) walk(id);

  // Finishing order reversed: everything before what it leads to.
  const column = new Map<string, number>();
  for (const id of finished.reverse()) {
    const before = (incoming.get(id) ?? []).filter((e) => !e.back);
    column.set(id, before.length === 0 ? 0 : Math.max(...before.map((e) => column.get(e.from)! + 1)));
  }

  // Separate graphs stack, so nothing crosses between them.
  const rowOf = new Map<string, number>();
  let rows = 0;
  for (const group of connectedGroups([...nodes.keys()], edges)) {
    const byColumn = new Map<number, string[]>();
    for (const id of group) byColumn.set(column.get(id)!, [...(byColumn.get(column.get(id)!) ?? []), id]);
    let tallest = 0;
    for (const c of [...byColumn.keys()].sort((a, b) => a - b)) {
      const ordered = byColumn.get(c)!
        .map((id) => ({ id, from: meanRow(id, incoming, rowOf) }))
        .sort((a, b) => a.from - b.from || (a.id < b.id ? -1 : 1));
      ordered.forEach(({ id }, i) => rowOf.set(id, rows + i));
      tallest = Math.max(tallest, ordered.length);
    }
    rows += tallest;
  }

  const placed = [...nodes.values()]
    .map((n): PlacedNode => ({ ...n, column: column.get(n.id)!, row: rowOf.get(n.id)! }))
    .sort((a, b) => a.column - b.column || a.row - b.row);
  return { nodes: placed, edges, columns: placed.length === 0 ? 0 : Math.max(...placed.map((n) => n.column)) + 1, rows };
}

/** The mean row of what leads here, in earlier columns; nothing yet sorts by name alone. */
function meanRow(id: string, incoming: Map<string, PlacedEdge[]>, rowOf: Map<string, number>): number {
  const rows = (incoming.get(id) ?? []).filter((e) => !e.back).map((e) => rowOf.get(e.from)!);
  return rows.length === 0 ? 0 : rows.reduce((a, b) => a + b, 0) / rows.length;
}

/** The node ids of each part of the graph, ignoring direction, in the order their first node comes. */
function connectedGroups(ids: string[], edges: ReadonlyArray<{ from: string; to: string }>): string[][] {
  const neighbours = new Map<string, string[]>(ids.map((id) => [id, []]));
  for (const { from, to } of edges) {
    neighbours.get(from)?.push(to);
    neighbours.get(to)?.push(from);
  }
  const seen = new Set<string>();
  const groups: string[][] = [];
  for (const id of [...ids].sort((a, b) => Number(b.startsWith('queue:')) - Number(a.startsWith('queue:')) || (a < b ? -1 : 1))) {
    if (seen.has(id)) continue;
    seen.add(id);
    const group = [id];
    for (let i = 0; i < group.length; i++) {
      for (const next of neighbours.get(group[i]!) ?? []) {
        if (!seen.has(next)) {
          seen.add(next);
          group.push(next);
        }
      }
    }
    groups.push(group);
  }
  return groups;
}

/** The parts of the map holding a queue whose name contains `search`, any case. An empty search keeps it all. */
export function mapComponent(map: DeadLetterMap, search: string): DeadLetterMap {
  const term = search.trim().toLowerCase();
  if (term === '') return map;
  const links = map.edges.flatMap((e) => ('to' in e ? [{ from: e.from, to: e.to }] : []));
  const kept = new Set(
    connectedGroups(map.nodes.map((n) => n.id), links)
      .filter((group) => group.some((id) => id.startsWith('queue:') && id.slice('queue:'.length).toLowerCase().includes(term)))
      .flat(),
  );
  return {
    nodes: map.nodes.filter((n) => kept.has(n.id)),
    edges: map.edges.filter((e) => kept.has(e.from)),
    cycles: map.cycles.filter((c) => c.every((id) => kept.has(id))),
  };
}

export const exchangeLabel = (name: string) => (name === '' ? 'default exchange' : `exchange ${name}`);

const SEVERITY_TEXT = { loses_messages: 'loses Messages', may_lose_messages: 'may lose Messages' } as const;

/**
 * The map as text: one line for each place a source queue's Messages can end
 * up, following only the edges they take (`sources`), then the cycles and the
 * set-up warnings. For screen readers and incident reports.
 */
export function mapListing(map: DeadLetterMap): string {
  const queues = new Map(map.nodes.flatMap((n) => (n.kind === 'queue' ? [[n.id, n] as const] : [])));
  const exchanges = new Map(map.nodes.flatMap((n) => (n.kind === 'exchange' ? [[n.id, n] as const] : [])));
  const depth = (id: string) => {
    const q = queues.get(id)!;
    return `${q.name} (≈ ${q.approximateMessages} ${q.approximateMessages === 1 ? 'Message' : 'Messages'})`;
  };

  /** Each way on from `at` for this source's Messages, as the text after `at`. */
  const onward = (at: string, source: string, seen: readonly string[]): string[] => {
    return map.edges.filter((e) => e.from === at && e.sources.includes(source)).flatMap((e) => {
      if (e.kind === 'drop') return [e.reason === 'exchange_missing' ? 'LOST: the exchange does not exist' : 'LOST: the exchange routes this to no queue'];
      if (e.kind === 'unresolved') return ['cannot be told from the set-up, not a loss'];
      if (!('to' in e) || seen.includes(e.to)) return [];
      if (queues.has(e.to)) return [depth(e.to)];
      const name = exchangeLabel(exchanges.get(e.to)!.name);
      const after = onward(e.to, source, [...seen, e.to]);
      return after.length === 0 ? [name] : after.map((rest) => `${name} → ${rest}`);
    });
  };

  const routes = [...queues.values()]
    .sort((a, b) => (a.name < b.name ? -1 : 1))
    .flatMap((q) =>
      map.edges
        .filter((e) => e.from === q.id)
        .flatMap((e) => {
          if (e.kind === 'convention') return [`${depth(q.id)} → ${depth(e.to)}, by MassTransit convention, not broker set-up`];
          if (e.kind !== 'dead_letter') return [];
          const key = e.routingKey === null ? "the Message's own routing key" : `routing key ${e.routingKey}`;
          const first = `${depth(q.id)} → ${exchangeLabel(exchanges.get(e.to)!.name)}, ${key}`;
          const ends = onward(e.to, q.name, [e.to]);
          return ends.length === 0 ? [first] : ends.map((end) => `${first} → ${end}`);
        }),
    );
  const cycles = map.cycles.map((cycle) => `Cycle: ${cycle.flatMap((id) => (queues.has(id) ? [queues.get(id)!.name] : [])).join(', ')}`);
  const warnings = [...queues.values()].flatMap((q) => q.setupWarnings.map((w) => `Set-up warning on ${q.name} (${SEVERITY_TEXT[w.severity]}): ${w.message}`));
  return [routes, cycles, warnings].filter((part) => part.length > 0).map((part) => part.join('\n')).join('\n\n');
}

export const NODE = { width: 180, queueHeight: 78, smallHeight: 36 };
export const CELL = { width: 320, height: 104 };
export const PAD = 16;
/** Room under the last row for the edges that go back. */
export const BOTTOM = 40;

export function nodeBox(n: Pick<PlacedNode, 'kind' | 'column' | 'row'>): { x: number; y: number; height: number } {
  const height = n.kind === 'queue' ? NODE.queueHeight : NODE.smallHeight;
  return { x: PAD + n.column * CELL.width, y: PAD + n.row * CELL.height + (NODE.queueHeight - height) / 2, height };
}

/**
 * The line of an edge and where its label goes. `lane` is the height it runs
 * at when it crosses columns: between the rows, where there are no nodes.
 */
export function edgeRoute(edge: PlacedEdge, from: PlacedNode, to: PlacedNode): { d: string; label: { x: number; y: number }; lane: number | null } {
  const a = nodeBox(from);
  const b = nodeBox(to);
  if (from.id === to.id) {
    const x = a.x + NODE.width / 2;
    const y = a.y + a.height;
    return { d: `M${x - 20} ${y} C${x - 40} ${y + 30} ${x + 40} ${y + 30} ${x + 20} ${y + 2}`, label: { x, y: y + 34 }, lane: null };
  }
  if (edge.back) {
    // Under the rows, so it never runs through a node on the way.
    const sx = a.x + NODE.width / 2;
    const sy = a.y + a.height;
    const ex = b.x + NODE.width / 2;
    const ey = b.y + b.height + 2;
    const low = Math.max(sy, ey) + 26;
    return { d: `M${sx} ${sy} C${sx} ${low} ${ex} ${low} ${ex} ${ey}`, label: { x: (sx + ex) / 2, y: low + 2 }, lane: null };
  }
  const x1 = a.x + NODE.width;
  const y1 = a.y + a.height / 2;
  const x2 = b.x;
  const y2 = b.y + b.height / 2;
  if (to.column - from.column === 1) {
    const bend = (x2 - x1) / 2;
    return { d: `M${x1} ${y1} C${x1 + bend} ${y1} ${x2 - bend} ${y2} ${x2 - 2} ${y2}`, label: { x: (x1 + x2) / 2, y: (y1 + y2) / 2 - 5 }, lane: null };
  }
  const gap = CELL.width - NODE.width;
  const lane = PAD + from.row * CELL.height + NODE.queueHeight + (CELL.height - NODE.queueHeight) / 2;
  const turn = gap / 4;
  return {
    d: `M${x1} ${y1} C${x1 + turn} ${y1} ${x1 + turn} ${lane} ${x1 + 2 * turn} ${lane} L${x2 - 2 * turn} ${lane} C${x2 - turn} ${lane} ${x2 - turn} ${y2} ${x2 - 2} ${y2}`,
    label: { x: x1 + gap / 2, y: y1 - 5 },
    lane,
  };
}
