// The Dead-letter Map's graph, built from one reading of a vhost's dead-letter
// set-up: real set-ups go through the edges, as the API sends them.
import { describe, expect, it } from 'vitest';
import { deadLetterMap } from '../../src/server/triage/dead-letter-map.js';
import { deadLetterEdges } from '../../src/server/triage/dead-letter-edges.js';
import type { ManagementBinding, ManagementExchange, ManagementQueue } from '../../src/server/management.js';
import type { QueueRow } from '../../src/shared/queues.js';

const queue = (name: string, deadLetter?: { exchange: string; routingKey?: string }): ManagementQueue => ({
  name,
  type: 'classic',
  messages: 0,
  consumers: 0,
  arguments: deadLetter
    ? { 'x-dead-letter-exchange': deadLetter.exchange, ...(deadLetter.routingKey === undefined ? {} : { 'x-dead-letter-routing-key': deadLetter.routingKey }) }
    : {},
  effectivePolicy: {},
  deliveryLimit: null,
});
const exchange = (name: string, type = 'direct', alternateExchange: string | null = null): ManagementExchange => ({ name, type, internal: false, alternateExchange });
const toQueue = (source: string, destination: string, routingKey = ''): ManagementBinding => ({ source, destination, destinationType: 'queue', routingKey });
const toExchange = (source: string, destination: string, routingKey = ''): ManagementBinding => ({ source, destination, destinationType: 'exchange', routingKey });
const row = (q: ManagementQueue, overrides: Partial<QueueRow> = {}): QueueRow => ({
  name: q.name,
  type: q.type,
  approximateMessages: 0,
  consumers: 0,
  deadLetterQueue: false,
  matchesDefaultFilter: false,
  deadLetteredFrom: [],
  checkout: { available: true },
  setupWarnings: [],
  checkedOutBy: null,
  ...overrides,
});

function build(queues: ManagementQueue[], exchanges: ManagementExchange[] = [], bindings: ManagementBinding[] = [], rows: Record<string, Partial<QueueRow>> = {}) {
  const edges = deadLetterEdges(queues, { exchanges: new Map(exchanges.map((e) => [e.name, e])), bindings });
  return deadLetterMap({ queues: queues.map((q) => row(q, rows[q.name])), edges });
}
const ids = (map: ReturnType<typeof build>) => map.nodes.map((n) => n.id);

describe('the Dead-letter Map', () => {
  it('follows a chain, a dead-letter queue dead-lettering onward to a parking queue, and leaves other queues out', () => {
    const warning = { code: 'quorum_at_most_once_dead_lettering', severity: 'may_lose_messages', message: 'm' } as const;
    const map = build(
      [queue('work', { exchange: 'dlx', routingKey: 'dead' }), queue('dead', { exchange: 'park' }), queue('parked'), queue('bystander')],
      [exchange('dlx'), exchange('park', 'fanout')],
      [toQueue('dlx', 'dead', 'dead'), toQueue('park', 'parked')],
      { dead: { type: 'quorum', approximateMessages: 7, setupWarnings: [warning] } },
    );

    expect(ids(map)).toEqual(['exchange:dlx', 'exchange:park', 'queue:dead', 'queue:parked', 'queue:work']);
    expect(map.nodes.find((n) => n.id === 'queue:dead')).toEqual({
      id: 'queue:dead',
      kind: 'queue',
      name: 'dead',
      type: 'quorum',
      approximateMessages: 7,
      setupWarnings: [warning],
      inCycle: false,
      deadLetterQueue: false,
      checkout: { available: true },
      checkedOutBy: null,
    });
    expect(map.nodes.find((n) => n.id === 'exchange:dlx')).toEqual({ id: 'exchange:dlx', kind: 'exchange', name: 'dlx', missing: false, inCycle: false });
    expect(map.edges).toEqual([
      { kind: 'dead_letter', from: 'queue:work', to: 'exchange:dlx', routingKey: 'dead', sources: ['work'] },
      { kind: 'binding', from: 'exchange:dlx', to: 'queue:dead', bindingKey: 'dead', sources: ['work'] },
      { kind: 'dead_letter', from: 'queue:dead', to: 'exchange:park', routingKey: null, sources: ['dead'] },
      { kind: 'binding', from: 'exchange:park', to: 'queue:parked', bindingKey: '', sources: ['dead'] },
    ]);
    expect(map.cycles).toEqual([]);
  });

  it('fans out, telling which source takes which edge of a shared exchange', () => {
    const map = build(
      [queue('a', { exchange: 'dlx', routingKey: 'a' }), queue('b', { exchange: 'dlx', routingKey: 'b' }), queue('c', { exchange: 'dlx', routingKey: 'a' }), queue('a.dead'), queue('a.audit'), queue('b.dead')],
      [exchange('dlx')],
      [toQueue('dlx', 'a.dead', 'a'), toQueue('dlx', 'a.audit', 'a'), toQueue('dlx', 'b.dead', 'b')],
    );

    expect(map.edges.filter((e) => e.kind === 'binding')).toEqual([
      { kind: 'binding', from: 'exchange:dlx', to: 'queue:a.dead', bindingKey: 'a', sources: ['a', 'c'] },
      { kind: 'binding', from: 'exchange:dlx', to: 'queue:a.audit', bindingKey: 'a', sources: ['a', 'c'] },
      { kind: 'binding', from: 'exchange:dlx', to: 'queue:b.dead', bindingKey: 'b', sources: ['b'] },
    ]);
  });

  it('follows an exchange-to-exchange binding and an alternate exchange', () => {
    const map = build(
      [queue('work', { exchange: 'first', routingKey: 'k' }), queue('dead'), queue('other', { exchange: 'picky', routingKey: 'unmatched' }), queue('caught')],
      [exchange('first'), exchange('second', 'fanout'), exchange('picky', 'direct', 'catch-all'), exchange('catch-all', 'fanout')],
      [toExchange('first', 'second', 'k'), toQueue('second', 'dead'), toQueue('catch-all', 'caught')],
    );

    expect(map.edges).toContainEqual({ kind: 'binding', from: 'exchange:first', to: 'exchange:second', bindingKey: 'k', sources: ['work'] });
    expect(map.edges).toContainEqual({ kind: 'binding', from: 'exchange:second', to: 'queue:dead', bindingKey: '', sources: ['work'] });
    expect(map.edges).toContainEqual({ kind: 'alternate_exchange', from: 'exchange:picky', to: 'exchange:catch-all', sources: ['other'] });
    expect(ids(map)).toContain('queue:caught');
  });

  it('goes through the default exchange to the queue the dead-letter routing key names', () => {
    const map = build([queue('work', { exchange: '', routingKey: 'dead' }), queue('dead')]);

    expect(map.edges).toEqual([
      { kind: 'dead_letter', from: 'queue:work', to: 'exchange:', routingKey: 'dead', sources: ['work'] },
      { kind: 'default_exchange', from: 'exchange:', to: 'queue:dead', sources: ['work'] },
    ]);
  });

  it('draws a missing exchange, and one that routes nowhere, as a loss', () => {
    const map = build(
      [queue('lost', { exchange: 'gone' }), queue('unbound', { exchange: 'empty' }), queue('unmatched', { exchange: 'picky', routingKey: 'no' }), queue('typo', { exchange: '', routingKey: 'nothing' }), queue('elsewhere')],
      [exchange('empty'), exchange('picky')],
      [toQueue('picky', 'elsewhere', 'yes')],
    );

    expect(map.edges.filter((e) => e.kind === 'drop')).toEqual([
      { kind: 'drop', from: 'exchange:gone', reason: 'exchange_missing', sources: ['lost'] },
      { kind: 'drop', from: 'exchange:empty', reason: 'routes_nowhere', sources: ['unbound'] },
      { kind: 'drop', from: 'exchange:picky', reason: 'routes_nowhere', sources: ['unmatched'] },
      { kind: 'drop', from: 'exchange:', reason: 'routes_nowhere', sources: ['typo'] },
    ]);
    expect(map.nodes.find((n) => n.id === 'exchange:gone')).toMatchObject({ missing: true });
    expect(map.nodes.find((n) => n.id === 'exchange:empty')).toMatchObject({ missing: false });
    // Bound to the exchange, but the key never takes a Message there.
    expect(ids(map)).not.toContain('queue:elsewhere');
  });

  it('does not call a destination that cannot be told a loss', () => {
    const map = build([queue('work', { exchange: '' })]);

    expect(map.edges).toContainEqual({ kind: 'unresolved', from: 'exchange:', sources: ['work'] });
    expect(map.edges.some((e) => e.kind === 'drop')).toBe(false);
  });

  it('links a MassTransit input queue to its _error queue by convention, and leaves an _error queue without one out', () => {
    const map = build([queue('orders'), queue('orders_error'), queue('stranded_error'), queue('bystander')]);

    expect(map.edges).toEqual([{ kind: 'convention', from: 'queue:orders', to: 'queue:orders_error', sources: ['orders'] }]);
    expect(ids(map)).toEqual(['queue:orders', 'queue:orders_error']);
  });

  it('flags a cycle on its queues and the exchanges on the way', () => {
    const map = build(
      [queue('retry', { exchange: 'to-wait', routingKey: 'wait' }), queue('wait', { exchange: 'to-retry', routingKey: 'retry' }), queue('into', { exchange: 'to-wait', routingKey: 'wait' }), queue('other', { exchange: 'side' }), queue('side.dead')],
      [exchange('to-wait'), exchange('to-retry'), exchange('side', 'fanout')],
      [toQueue('to-wait', 'wait', 'wait'), toQueue('to-retry', 'retry', 'retry'), toQueue('side', 'side.dead')],
    );

    expect(map.cycles).toEqual([['exchange:to-retry', 'exchange:to-wait', 'queue:retry', 'queue:wait']]);
    expect(map.nodes.filter((n) => n.inCycle).map((n) => n.id)).toEqual(map.cycles[0]);
  });

  it('flags a queue that dead-letters into itself', () => {
    const map = build([queue('loop', { exchange: '', routingKey: 'loop' })]);

    expect(map.cycles).toEqual([['exchange:', 'queue:loop']]);
  });

  it('does not see a cycle in two queues that only share an exchange', () => {
    const map = build(
      [queue('a', { exchange: 'dlx', routingKey: 'to-b' }), queue('b', { exchange: 'dlx', routingKey: 'to-c' }), queue('c')],
      [exchange('dlx')],
      [toQueue('dlx', 'b', 'to-b'), toQueue('dlx', 'c', 'to-c')],
    );

    expect(map.cycles).toEqual([]);
    expect(map.nodes.some((n) => n.inCycle)).toBe(false);
  });

  it('does not call exchanges bound to each other a cycle: no queue gets a Message back', () => {
    const map = build(
      [queue('work', { exchange: 'x1' }), queue('dead')],
      [exchange('x1', 'fanout'), exchange('x2', 'fanout')],
      [toExchange('x1', 'x2'), toExchange('x2', 'x1'), toQueue('x2', 'dead')],
    );

    expect(map.cycles).toEqual([]);
  });

  it('counts a convention edge towards a cycle', () => {
    const map = build([queue('orders'), queue('orders_error', { exchange: '', routingKey: 'orders' })]);

    expect(map.cycles).toEqual([['exchange:', 'queue:orders', 'queue:orders_error']]);
  });
});
