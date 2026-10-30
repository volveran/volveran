// The pure logic of the Dead-letter Map's diagram: columns by distance, order
// within a column, loops placed without looping, the connected-component search
// and the text listing.
import { describe, expect, it } from 'vitest';
import { edgeRoute, layoutMap, mapComponent, mapListing, nodeBox } from '../../src/web/dead-letter-map-view.js';
import type { DeadLetterMap, DeadLetterMapEdge, DeadLetterMapNode } from '../../src/shared/dead-letter-map.js';

const q = (name: string, inCycle = false): DeadLetterMapNode => ({
  id: `queue:${name}`, kind: 'queue', name, type: 'classic', approximateMessages: 0, setupWarnings: [], inCycle,
  deadLetterQueue: false, checkout: { available: true }, checkedOutBy: null,
});
const x = (name: string, extra: { missing?: boolean; inCycle?: boolean } = {}): DeadLetterMapNode => ({ id: `exchange:${name}`, kind: 'exchange', name, missing: false, inCycle: false, ...extra });
const deadLetter = (queue: string, exchange: string, routingKey: string | null = null): DeadLetterMapEdge => ({ kind: 'dead_letter', from: `queue:${queue}`, to: `exchange:${exchange}`, routingKey, sources: [queue] });
const binding = (exchange: string, to: string, sources: string[], bindingKey = ''): DeadLetterMapEdge => ({ kind: 'binding', from: `exchange:${exchange}`, to, bindingKey, sources });
const map = (nodes: DeadLetterMapNode[], edges: DeadLetterMapEdge[], cycles: string[][] = []): DeadLetterMap => ({ nodes, edges, cycles });

const columnsOf = (m: DeadLetterMap) => Object.fromEntries(layoutMap(m).nodes.map((n) => [n.id, n.column]));

const chain = map(
  [x('dlx'), x('park'), q('dead'), q('parked'), q('work')],
  [deadLetter('work', 'dlx', 'dead'), binding('dlx', 'queue:dead', ['work'], 'dead'), deadLetter('dead', 'park'), binding('park', 'queue:parked', ['dead'])],
);

describe('layoutMap', () => {
  it('puts a chain in columns by distance from its first queue', () => {
    expect(columnsOf(chain)).toEqual({ 'queue:work': 0, 'exchange:dlx': 1, 'queue:dead': 2, 'exchange:park': 3, 'queue:parked': 4 });
  });

  it('puts a queue reached by a short and a long path right of both', () => {
    const m = map(
      [x('first'), x('second'), q('a'), q('dead'), q('via')],
      [deadLetter('a', 'first'), binding('first', 'queue:dead', ['a']), binding('first', 'queue:via', ['a']), deadLetter('via', 'second'), binding('second', 'queue:dead', ['via'])],
    );
    expect(columnsOf(m)['queue:dead']).toBe(4);
  });

  it('gives a loss and an unresolved destination a place of their own after their exchange', () => {
    const m = map(
      [x('gone', { missing: true }), x('headers'), q('a'), q('b')],
      [
        deadLetter('a', 'gone'),
        { kind: 'drop', from: 'exchange:gone', reason: 'exchange_missing', sources: ['a'] },
        deadLetter('b', 'headers'),
        { kind: 'unresolved', from: 'exchange:headers', sources: ['b'] },
      ],
    );
    const layout = layoutMap(m);
    expect(layout.nodes.find((n) => n.id === 'loss:gone')).toMatchObject({ kind: 'loss', column: 2, reason: 'exchange_missing' });
    expect(layout.nodes.find((n) => n.id === 'unresolved:headers')).toMatchObject({ kind: 'unresolved', column: 2 });
    expect(layout.edges.find((e) => e.to === 'loss:gone')).toMatchObject({ kind: 'drop', back: false });
  });

  it('places a cycle in columns with one edge going back, starting from a queue', () => {
    const m = map(
      [x('', { inCycle: true }), q('a', true), q('b', true)],
      [deadLetter('a', '', 'b'), { kind: 'default_exchange', from: 'exchange:', to: 'queue:b', sources: ['a'] }, deadLetter('b', '', 'a'), { kind: 'default_exchange', from: 'exchange:', to: 'queue:a', sources: ['b'] }],
      [['exchange:', 'queue:a', 'queue:b']],
    );
    const layout = layoutMap(m);
    expect(columnsOf(m)).toEqual({ 'queue:a': 0, 'exchange:': 1, 'queue:b': 2 });
    const column = new Map(layout.nodes.map((n) => [n.id, n.column]));
    for (const e of layout.edges) {
      if (e.back) expect(column.get(e.to)!).toBeLessThanOrEqual(column.get(e.from)!);
      else expect(column.get(e.to)!).toBeGreaterThan(column.get(e.from)!);
    }
    expect(layout.edges.filter((e) => e.back).map((e) => [e.from, e.to])).toEqual([['queue:b', 'exchange:'], ['exchange:', 'queue:a']]);
    expect(layout.edges.every((e) => e.inCycle)).toBe(true);
  });

  it('copes with a loop that is not a cycle, and does not flag it', () => {
    // a → dlx → b → dlx → c: b's Messages go on to c, never back to b.
    const m = map(
      [x('dlx'), q('a'), q('b'), q('c')],
      [deadLetter('a', 'dlx', 'to-b'), binding('dlx', 'queue:b', ['a'], 'to-b'), deadLetter('b', 'dlx', 'to-c'), binding('dlx', 'queue:c', ['b'], 'to-c')],
    );
    const layout = layoutMap(m);
    expect(layout.edges.filter((e) => e.back).map((e) => [e.from, e.to])).toEqual([['queue:b', 'exchange:dlx']]);
    expect(layout.edges.some((e) => e.inCycle)).toBe(false);
  });

  it('survives an exchange bound to itself', () => {
    const m = map([x('dlx'), q('a'), q('b')], [deadLetter('a', 'dlx'), binding('dlx', 'exchange:dlx', ['a']), binding('dlx', 'queue:b', ['a'])]);
    const layout = layoutMap(m);
    expect(layout.edges.find((e) => e.from === e.to)).toMatchObject({ back: true });
  });

  it('orders a column by where its nodes come from, then by name', () => {
    const m = map(
      [x('x1'), x('x2'), q('a'), q('b'), q('m1'), q('m2'), q('z')],
      [
        deadLetter('a', 'x2'), binding('x2', 'queue:z', ['a']),
        deadLetter('b', 'x1'), binding('x1', 'queue:m2', ['b']), binding('x1', 'queue:m1', ['b']),
      ],
    );
    const rows = Object.fromEntries(layoutMap(m).nodes.map((n) => [n.id, n.row]));
    // Separate graphs stack: a's above b's, b's targets by name.
    expect(rows['queue:a']).toBeLessThan(rows['queue:b']!);
    expect(rows['queue:z']).toBeLessThan(rows['queue:m1']!);
    expect(rows['queue:m1']).toBeLessThan(rows['queue:m2']!);
  });

  it('follows the order of the previous column, even against the names', () => {
    const m = map(
      [x('x1'), x('x2'), q('a'), q('b'), q('end')],
      [deadLetter('a', 'x2'), deadLetter('b', 'x1'), binding('x1', 'queue:end', ['b']), binding('x2', 'queue:end', ['a'])],
    );
    const rows = Object.fromEntries(layoutMap(m).nodes.map((n) => [n.id, n.row]));
    expect(rows['exchange:x2']).toBeLessThan(rows['exchange:x1']!);
  });

  it('never gives two nodes the same place', () => {
    const places = layoutMap(chain).nodes.map((n) => `${n.column}/${n.row}`);
    expect(new Set(places).size).toBe(places.length);
  });

  it('merges two bindings between the same nodes into one labelled edge', () => {
    const m = map([x('dlx'), q('a'), q('b')], [deadLetter('a', 'dlx'), binding('dlx', 'queue:b', ['a'], 'one'), binding('dlx', 'queue:b', ['a'], 'two')]);
    expect(layoutMap(m).edges.filter((e) => e.to === 'queue:b')).toMatchObject([{ labels: ['key one', 'key two'] }]);
  });

  it('labels the edges with routing and binding keys', () => {
    const labels = Object.fromEntries(layoutMap(chain).edges.map((e) => [`${e.from}>${e.to}`, e.labels]));
    expect(labels['queue:work>exchange:dlx']).toEqual(['routing key dead']);
    expect(labels['queue:dead>exchange:park']).toEqual(["Message's own routing key"]);
    expect(labels['exchange:dlx>queue:dead']).toEqual(['key dead']);
    expect(labels['exchange:park>queue:parked']).toEqual([]);
  });

  it('marks a convention edge as such', () => {
    const m = map([q('billing'), q('billing_error')], [{ kind: 'convention', from: 'queue:billing', to: 'queue:billing_error', sources: ['billing'] }]);
    expect(layoutMap(m)).toMatchObject({ edges: [{ kind: 'convention', labels: ['by convention'], back: false }], nodes: [{ id: 'queue:billing', column: 0 }, { id: 'queue:billing_error', column: 1 }] });
  });

  it('lays out an empty map', () => {
    expect(layoutMap(map([], []))).toEqual({ nodes: [], edges: [], columns: 0, rows: 0 });
  });
});

const ids = (m: DeadLetterMap) => m.nodes.map((n) => n.id);

describe('mapComponent', () => {
  const two = map(
    [x('dlx'), x('other'), q('dead'), q('lone'), q('lone.dead'), q('work')],
    [deadLetter('work', 'dlx'), binding('dlx', 'queue:dead', ['work']), deadLetter('lone', 'other'), binding('other', 'queue:lone.dead', ['lone'])],
    [['queue:lone', 'queue:lone.dead']],
  );

  it('keeps only what connects to the queue found, upstream and downstream', () => {
    const found = mapComponent(two, 'DEAD');
    expect(ids(mapComponent(two, 'work'))).toEqual(['exchange:dlx', 'queue:dead', 'queue:work']);
    expect(ids(mapComponent(two, 'lone.dead'))).toEqual(['exchange:other', 'queue:lone', 'queue:lone.dead']);
    expect(ids(found)).toEqual(ids(two)); // a part of the name, any case: both graphs have a match
  });

  it('keeps the edges and cycles of the part it keeps', () => {
    const found = mapComponent(two, 'work');
    expect(found.edges).toHaveLength(2);
    expect(found.cycles).toEqual([]);
    expect(mapComponent(two, 'lone').cycles).toEqual([['queue:lone', 'queue:lone.dead']]);
  });

  it('searches queue names, not exchange names', () => {
    expect(ids(mapComponent(two, 'dlx'))).toEqual([]);
  });

  it('shows everything for an empty search', () => {
    expect(mapComponent(two, '  ')).toEqual(two);
  });
});

describe('mapListing', () => {
  const lines = (m: DeadLetterMap) => mapListing(m).split('\n');

  it('lists each source queue with its exchange, routing key and where it ends up', () => {
    expect(lines(chain)).toEqual([
      'dead (≈ 0 Messages) → exchange park, the Message\'s own routing key → parked (≈ 0 Messages)',
      'work (≈ 0 Messages) → exchange dlx, routing key dead → dead (≈ 0 Messages)',
    ]);
  });

  it('follows only the edges the source queue\'s own Messages take', () => {
    const m = map(
      [x('dlx'), q('a'), q('b'), q('c')],
      [deadLetter('a', 'dlx', 'to-b'), binding('dlx', 'queue:b', ['a'], 'to-b'), deadLetter('b', 'dlx', 'to-c'), binding('dlx', 'queue:c', ['b'], 'to-c')],
    );
    expect(lines(m)).toEqual([
      'a (≈ 0 Messages) → exchange dlx, routing key to-b → b (≈ 0 Messages)',
      'b (≈ 0 Messages) → exchange dlx, routing key to-c → c (≈ 0 Messages)',
    ]);
  });

  it('gives one line per destination, through exchanges bound to exchanges', () => {
    const m = map(
      [x('first'), x('second'), q('a'), q('d1'), q('d2')],
      [deadLetter('a', 'first', 'k'), binding('first', 'exchange:second', ['a']), binding('second', 'queue:d1', ['a']), binding('first', 'queue:d2', ['a'])],
    );
    expect(lines(m)).toEqual([
      'a (≈ 0 Messages) → exchange first, routing key k → exchange second → d1 (≈ 0 Messages)',
      'a (≈ 0 Messages) → exchange first, routing key k → d2 (≈ 0 Messages)',
    ]);
  });

  it('says a drop is a loss, and that an unresolved destination is not', () => {
    const m = map(
      [x('gone', { missing: true }), x('empty'), x('headers'), q('a'), q('b'), q('c')],
      [
        deadLetter('a', 'gone'), { kind: 'drop', from: 'exchange:gone', reason: 'exchange_missing', sources: ['a'] },
        deadLetter('b', 'empty', 'k'), { kind: 'drop', from: 'exchange:empty', reason: 'routes_nowhere', sources: ['b'] },
        deadLetter('c', 'headers'), { kind: 'unresolved', from: 'exchange:headers', sources: ['c'] },
      ],
    );
    expect(lines(m)).toEqual([
      "a (≈ 0 Messages) → exchange gone, the Message's own routing key → LOST: the exchange does not exist",
      'b (≈ 0 Messages) → exchange empty, routing key k → LOST: the exchange routes this to no queue',
      "c (≈ 0 Messages) → exchange headers, the Message's own routing key → cannot be told from the set-up, not a loss",
    ]);
  });

  it('names the default exchange, and says a convention edge is one', () => {
    const m = map(
      [x(''), q('a'), q('b'), q('billing'), q('billing_error')],
      [deadLetter('a', '', 'b'), { kind: 'default_exchange', from: 'exchange:', to: 'queue:b', sources: ['a'] }, { kind: 'convention', from: 'queue:billing', to: 'queue:billing_error', sources: ['billing'] }],
    );
    expect(lines(m)).toEqual([
      'a (≈ 0 Messages) → default exchange, routing key b → b (≈ 0 Messages)',
      'billing (≈ 0 Messages) → billing_error (≈ 0 Messages), by MassTransit convention, not broker set-up',
    ]);
  });

  it('ends without looping through a cycle, and lists the cycle and the set-up warnings', () => {
    const warned: DeadLetterMapNode = { ...q('b', true), approximateMessages: 3, setupWarnings: [{ code: 'dead_letter_unroutable', severity: 'may_lose_messages', message: 'It can loop.' }] } as DeadLetterMapNode;
    const m = map(
      [x('', { inCycle: true }), q('a', true), warned],
      [deadLetter('a', '', 'b'), { kind: 'default_exchange', from: 'exchange:', to: 'queue:b', sources: ['a'] }, deadLetter('b', '', 'a'), { kind: 'default_exchange', from: 'exchange:', to: 'queue:a', sources: ['b'] }],
      [['exchange:', 'queue:a', 'queue:b']],
    );
    expect(lines(m)).toEqual([
      'a (≈ 0 Messages) → default exchange, routing key b → b (≈ 3 Messages)',
      'b (≈ 3 Messages) → default exchange, routing key a → a (≈ 0 Messages)',
      '',
      'Cycle: a, b',
      '',
      'Set-up warning on b (may lose Messages): It can loop.',
    ]);
  });

  it('writes one Message in the singular', () => {
    expect(mapListing(map([q('a'), q('a_error')].map((n) => ({ ...n, approximateMessages: 1 }) as DeadLetterMapNode), [{ kind: 'convention', from: 'queue:a', to: 'queue:a_error', sources: ['a'] }]))).toContain('a (≈ 1 Message) →');
  });

  it('is empty for an empty map', () => {
    expect(mapListing(map([], []))).toBe('');
  });
});

describe('edgeRoute', () => {
  it('takes an edge that crosses columns between the rows, not through the nodes on the way', () => {
    // long → park crosses the columns of dlx and dead, in its own row.
    const m = map(
      [x('dlx'), x('park'), q('dead'), q('long'), q('parked'), q('work')],
      [deadLetter('long', 'park'), deadLetter('work', 'dlx', 'dead'), binding('dlx', 'queue:dead', ['work'], 'dead'), deadLetter('dead', 'park'), binding('park', 'queue:parked', ['dead', 'long'])],
    );
    const layout = layoutMap(m);
    const node = (id: string) => layout.nodes.find((n) => n.id === id)!;
    const edge = layout.edges.find((e) => e.from === 'queue:long')!;
    const { lane } = edgeRoute(edge, node(edge.from), node(edge.to));
    expect(lane).not.toBeNull();
    for (const n of layout.nodes) {
      const box = nodeBox(n);
      expect(lane! <= box.y || lane! >= box.y + box.height).toBe(true);
    }
  });

  it('draws an edge to the next column straight across the gap', () => {
    const layout = layoutMap(chain);
    const node = (id: string) => layout.nodes.find((n) => n.id === id)!;
    const edge = layout.edges.find((e) => e.from === 'queue:work')!;
    expect(edgeRoute(edge, node(edge.from), node(edge.to)).lane).toBeNull();
  });
});
