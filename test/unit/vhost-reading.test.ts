// One reading of a vhost's dead-letter set-up: the queue rows and the
// dead-letter edges, from the management API.
import { describe, expect, it } from 'vitest';
import { readVhost, type VhostReading } from '../../src/server/triage/vhost-reading.js';
import type { ManagementBinding, ManagementExchange, ManagementQueue } from '../../src/server/management.js';
import type { BrokerProfile } from '../../src/server/profiles.js';

const queue = (name: string, args: Record<string, unknown> = {}, policy: Record<string, unknown> = {}): ManagementQueue => ({
  name,
  type: 'classic',
  messages: 0,
  consumers: 0,
  arguments: args,
  effectivePolicy: policy,
  deliveryLimit: null,
});
const exchange = (name: string, type = 'direct', alternateExchange: string | null = null): ManagementExchange => ({
  name,
  type,
  internal: false,
  alternateExchange,
});
const toQueue = (source: string, destination: string, routingKey = ''): ManagementBinding => ({ source, destination, destinationType: 'queue', routingKey });
const toExchange = (source: string, destination: string, routingKey = ''): ManagementBinding => ({ source, destination, destinationType: 'exchange', routingKey });

async function read(queues: ManagementQueue[], exchanges: ManagementExchange[], bindings: ManagementBinding[], defaultQueueFilter?: string): Promise<VhostReading> {
  const management = {
    listQueues: async () => queues,
    listBindings: async () => bindings,
    listExchanges: async () => exchanges,
  };
  return readVhost({ profile: { defaultQueueFilter } as BrokerProfile, management }, '/');
}

/** The edges that carry Messages, as `from -key-> target`. */
const routed = (reading: VhostReading, source: string) =>
  reading.edges
    .filter((e) => e.source === source && e.routes)
    .map((e) => `${e.from} ${e.bindingKey ?? '-'} ${e.target.type}:${e.target.type === 'drop' ? e.target.reason : e.target.type === 'unresolved' ? '' : e.target.name}`);

describe('the dead-letter edges', () => {
  it('reads the dead-letter exchange and routing key from a queue argument', async () => {
    const reading = await read(
      [queue('w', { 'x-dead-letter-exchange': 'dlx', 'x-dead-letter-routing-key': 'k' }), queue('w.dlq')],
      [exchange('dlx')],
      [toQueue('dlx', 'w.dlq', 'k')],
    );
    expect(reading.edges).toEqual([
      {
        source: 'w',
        deadLetterExchange: 'dlx',
        routingKey: 'k',
        from: 'dlx',
        via: 'binding',
        bindingKey: 'k',
        target: { type: 'queue', name: 'w.dlq' },
        routes: true,
        countsAsDeadLetteredFrom: true,
      },
    ]);
  });

  it('reads them from a policy', async () => {
    const reading = await read(
      [queue('w', {}, { 'dead-letter-exchange': 'dlx', 'dead-letter-routing-key': 'k' })],
      [exchange('dlx')],
      [toQueue('dlx', 'w.dlq', 'k')],
    );
    expect(reading.edges[0]).toMatchObject({ deadLetterExchange: 'dlx', routingKey: 'k' });
    expect(routed(reading, 'w')).toEqual(['dlx k queue:w.dlq']);
  });

  it('lets the argument win over the policy, as the broker does', async () => {
    const reading = await read(
      [queue('w', { 'x-dead-letter-exchange': 'by-arg' }, { 'dead-letter-exchange': 'by-policy' }), queue('a.dlq'), queue('p.dlq')],
      [exchange('by-arg', 'fanout'), exchange('by-policy', 'fanout')],
      [toQueue('by-arg', 'a.dlq'), toQueue('by-policy', 'p.dlq')],
    );
    expect(routed(reading, 'w')).toEqual(['by-arg  queue:a.dlq']);
  });

  it('routes a set routing key only through bindings that match it', async () => {
    const reading = await read(
      [queue('w', { 'x-dead-letter-exchange': 'dlx', 'x-dead-letter-routing-key': 'orders.eu' })],
      [exchange('dlx', 'topic')],
      [toQueue('dlx', 'eu.dlq', 'orders.*'), toQueue('dlx', 'us.dlq', 'billing.#')],
    );
    expect(routed(reading, 'w')).toEqual(['dlx orders.* queue:eu.dlq']);
  });

  it('says "keeps routing key" with null, and routes the keys the queue receives', async () => {
    const reading = await read(
      [queue('w', { 'x-dead-letter-exchange': 'dlx' })],
      [exchange('in'), exchange('dlx')],
      [toQueue('in', 'w', 'orders'), toQueue('dlx', 'o.dlq', 'orders'), toQueue('dlx', 'b.dlq', 'billing')],
    );
    expect(reading.edges.find((e) => e.routes)).toMatchObject({ routingKey: null });
    expect(routed(reading, 'w')).toEqual(['dlx orders queue:o.dlq']);
  });

  it('counts every binding as routing when a kept routing key cannot be known', async () => {
    const reading = await read(
      [queue('w', { 'x-dead-letter-exchange': 'dlx' })],
      [exchange('in', 'fanout'), exchange('dlx')],
      [toQueue('in', 'w'), toQueue('dlx', 'o.dlq', 'orders'), toQueue('dlx', 'b.dlq', 'billing')],
    );
    expect(routed(reading, 'w')).toEqual(['dlx orders queue:o.dlq', 'dlx billing queue:b.dlq']);
  });

  it('follows exchange-to-exchange bindings with the key, without looping on cycles', async () => {
    const reading = await read(
      [queue('w', { 'x-dead-letter-exchange': 'x1', 'x-dead-letter-routing-key': 'k' })],
      [exchange('x1'), exchange('x2', 'topic')],
      [toExchange('x1', 'x2', 'k'), toExchange('x2', 'x1', '#'), toQueue('x2', 'deep.dlq', 'k'), toQueue('x2', 'other.dlq', 'nope')],
    );
    expect(routed(reading, 'w')).toEqual(['x1 k exchange:x2', 'x2 # exchange:x1', 'x2 k queue:deep.dlq']);
  });

  it('follows an alternate exchange for a key the exchange cannot route', async () => {
    const reading = await read(
      [queue('w', { 'x-dead-letter-exchange': 'dlx', 'x-dead-letter-routing-key': 'k' })],
      [exchange('dlx', 'direct', 'ae'), exchange('ae', 'fanout')],
      [toQueue('ae', 'caught.dlq')],
    );
    expect(reading.edges.find((e) => e.via === 'alternate_exchange')).toMatchObject({ from: 'dlx', bindingKey: null, target: { type: 'exchange', name: 'ae' } });
    expect(routed(reading, 'w')).toEqual(['dlx - exchange:ae', 'ae  queue:caught.dlq']);
  });

  it('leaves out the alternate exchange when the key is routed', async () => {
    const reading = await read(
      [queue('w', { 'x-dead-letter-exchange': 'dlx', 'x-dead-letter-routing-key': 'k' })],
      [exchange('dlx', 'direct', 'ae'), exchange('ae', 'fanout')],
      [toQueue('dlx', 'w.dlq', 'k'), toQueue('ae', 'caught.dlq')],
    );
    expect(routed(reading, 'w')).toEqual(['dlx k queue:w.dlq']);
  });

  it('ends in a drop edge when the dead-letter exchange is missing', async () => {
    const reading = await read([queue('w', { 'x-dead-letter-exchange': 'gone' })], [], []);
    expect(reading.edges).toEqual([
      expect.objectContaining({ source: 'w', deadLetterExchange: 'gone', routingKey: null, from: 'gone', via: null, target: { type: 'drop', reason: 'exchange_missing' }, routes: true }),
    ]);
  });

  it('ends in a drop edge when the exchange routes the key nowhere', async () => {
    const reading = await read(
      [queue('w', { 'x-dead-letter-exchange': 'dlx', 'x-dead-letter-routing-key': 'k' })],
      [exchange('dlx')],
      [toQueue('dlx', 'other.dlq', 'nope')],
    );
    expect(routed(reading, 'w')).toEqual(['dlx - drop:routes_nowhere']);
  });

  it('ends in a drop edge when an alternate exchange is missing', async () => {
    const reading = await read([queue('w', { 'x-dead-letter-exchange': 'dlx' })], [exchange('dlx', 'direct', 'gone')], []);
    expect(routed(reading, 'w')).toEqual(['dlx - exchange:gone', 'gone - drop:exchange_missing']);
  });

  it('draws no drop edge when one of the kept routing keys routes', async () => {
    const reading = await read(
      [queue('w', { 'x-dead-letter-exchange': 'dlx' })],
      [exchange('in'), exchange('dlx')],
      [toQueue('in', 'w', 'orders'), toQueue('in', 'w', 'unbound'), toQueue('dlx', 'o.dlq', 'orders')],
    );
    expect(routed(reading, 'w')).toEqual(['dlx orders queue:o.dlq']);
  });

  it('trusts an exchange type whose routing bindings cannot decide', async () => {
    const reading = await read(
      [queue('w', { 'x-dead-letter-exchange': 'h', 'x-dead-letter-routing-key': 'k' })],
      [exchange('h', 'headers')],
      [toQueue('h', 'a.dlq', 'whatever')],
    );
    expect(routed(reading, 'w')).toEqual(['h whatever queue:a.dlq']);
    const empty = await read([queue('w', { 'x-dead-letter-exchange': 'h' })], [exchange('h', 'headers')], []);
    expect(routed(empty, 'w')).toEqual(['h - unresolved:']);
  });

  it('goes through the default exchange to the queue the routing key names', async () => {
    const reading = await read([queue('w', { 'x-dead-letter-exchange': '', 'x-dead-letter-routing-key': 'w.dlq' }), queue('w.dlq')], [], []);
    expect(reading.edges).toEqual([
      expect.objectContaining({ from: '', via: 'default_exchange', bindingKey: null, routingKey: 'w.dlq', target: { type: 'queue', name: 'w.dlq' }, routes: true }),
    ]);
  });

  it('ends in a drop edge when the default exchange has no queue of that name', async () => {
    const reading = await read([queue('w', { 'x-dead-letter-exchange': '', 'x-dead-letter-routing-key': 'gone' })], [], []);
    expect(routed(reading, 'w')).toEqual([' - drop:routes_nowhere']);
  });

  it('leaves the target unresolved through the default exchange with a kept routing key', async () => {
    const reading = await read([queue('w', { 'x-dead-letter-exchange': '' })], [], []);
    expect(reading.edges).toEqual([expect.objectContaining({ from: '', via: 'default_exchange', routingKey: null, target: { type: 'unresolved' }, routes: true })]);
  });

  it('has no edge for a queue that does not dead-letter', async () => {
    expect((await read([queue('w')], [], [])).edges).toEqual([]);
  });
});

describe('deadLetteredFrom, derived from the edges', () => {
  const sources = (reading: VhostReading, name: string) => reading.queues.find((q) => q.name === name)!.deadLetteredFrom;

  it('names a queue bound with a key that does not route: the queue list has always counted it', async () => {
    const reading = await read(
      [queue('w', { 'x-dead-letter-exchange': 'dlx', 'x-dead-letter-routing-key': 'k' }), queue('other.dlq')],
      [exchange('dlx')],
      [toQueue('dlx', 'other.dlq', 'nope')],
    );
    expect(sources(reading, 'other.dlq')).toEqual(['w']);
    expect(reading.queues.find((q) => q.name === 'other.dlq')!.deadLetterQueue).toBe(true);
  });

  it('names both exchanges when an argument and a policy differ', async () => {
    const reading = await read(
      [queue('w', { 'x-dead-letter-exchange': 'by-arg' }, { 'dead-letter-exchange': 'by-policy' }), queue('a.dlq'), queue('p.dlq')],
      [exchange('by-arg', 'fanout'), exchange('by-policy', 'fanout')],
      [toQueue('by-arg', 'a.dlq'), toQueue('by-policy', 'p.dlq')],
    );
    expect(sources(reading, 'a.dlq')).toEqual(['w']);
    expect(sources(reading, 'p.dlq')).toEqual(['w']);
  });

  it('does not name a queue reached only through an alternate exchange', async () => {
    const reading = await read(
      [queue('w', { 'x-dead-letter-exchange': 'dlx', 'x-dead-letter-routing-key': 'k' }), queue('caught')],
      [exchange('dlx', 'direct', 'ae'), exchange('ae', 'fanout')],
      [toQueue('ae', 'caught')],
    );
    expect(sources(reading, 'caught')).toEqual([]);
  });

  it('does not name a queue the default exchange reaches with a routing key from the policy and the exchange from the argument', async () => {
    const reading = await read(
      [queue('w', { 'x-dead-letter-exchange': '' }, { 'dead-letter-routing-key': 'p' }), queue('p')],
      [],
      [],
    );
    expect(routed(reading, 'w')).toEqual([' - queue:p']);
    expect(sources(reading, 'p')).toEqual([]);
  });
});

describe('the queue rows', () => {
  it('are the queue list\'s rows, in its order, without Checkout lock queues, with the warning counts of the vhost', async () => {
    const reading = await read(
      [{ ...queue('work', { 'x-dead-letter-exchange': 'gone' }), messages: 3, consumers: 1 }, queue('orders.dlq')],
      [],
      [],
      '*.dlq',
    );
    expect(reading.queues).toEqual([
      {
        name: 'orders.dlq',
        type: 'classic',
        approximateMessages: 0,
        consumers: 0,
        checkout: { available: true },
        checkedOutBy: null,
        deadLetterQueue: true,
        matchesDefaultFilter: true,
        deadLetteredFrom: [],
        setupWarnings: [],
      },
      {
        name: 'work',
        type: 'classic',
        approximateMessages: 3,
        consumers: 1,
        checkout: { available: true },
        checkedOutBy: null,
        deadLetterQueue: false,
        matchesDefaultFilter: false,
        deadLetteredFrom: [],
        setupWarnings: [expect.objectContaining({ code: 'dead_letter_exchange_missing' })],
      },
    ]);
    expect(reading.setupWarningCounts).toEqual({ loses_messages: 1, may_lose_messages: 0 });
  });
});
