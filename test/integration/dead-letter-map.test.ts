// The Dead-letter Map's graph from the API, on a vhost of its own set up with
// each thing the map shows.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { brokerUsers, management, startApp, testProfile, type TestApp } from './harness.js';

const vhost = 'dead-letter-map';
const vhostPath = encodeURIComponent(vhost);
const mapPath = `/api/profiles/local/vhosts/${vhostPath}/dead-letter-map`;

async function put(path: string, body: unknown) {
  expect((await management(path, { method: 'PUT', body })).status).toBeLessThan(300);
}
const declareQueue = (name: string, args: Record<string, unknown> = {}, type = 'classic') =>
  put(`/queues/${vhostPath}/${name}`, { durable: true, arguments: { 'x-queue-type': type, ...args } });
const declareExchange = (name: string, type = 'direct') => put(`/exchanges/${vhostPath}/${name}`, { type, durable: true });
async function bind(source: string, kind: 'q' | 'e', destination: string, routingKey = '') {
  const res = await management(`/bindings/${vhostPath}/e/${source}/${kind}/${destination}`, { method: 'POST', body: { routing_key: routingKey } });
  expect(res.status).toBeLessThan(300);
}

describe('Dead-letter Map API', () => {
  let app: TestApp;
  let map: any;

  beforeAll(async () => {
    await put(`/vhosts/${vhostPath}`, {});
    await put(`/permissions/${vhostPath}/${brokerUsers.admin.username}`, { configure: '.*', write: '.*', read: '.*' });

    // A chain: work to dead, dead onward to parked.
    await declareExchange('chain.dlx');
    await declareExchange('chain.park', 'fanout');
    await declareQueue('chain.work', { 'x-dead-letter-exchange': 'chain.dlx', 'x-dead-letter-routing-key': 'dead' });
    await declareQueue('chain.dead', { 'x-dead-letter-exchange': 'chain.park' }, 'quorum');
    await declareQueue('chain.parked');
    await bind('chain.dlx', 'q', 'chain.dead', 'dead');
    await bind('chain.park', 'q', 'chain.parked');

    // Through an exchange-to-exchange binding.
    await declareExchange('e2e.first', 'fanout');
    await declareExchange('e2e.second', 'fanout');
    await declareQueue('e2e.work', { 'x-dead-letter-exchange': 'e2e.first' });
    await declareQueue('e2e.dead');
    await bind('e2e.first', 'e', 'e2e.second');
    await bind('e2e.second', 'q', 'e2e.dead');

    // Losses: a missing exchange, and one nothing is bound to.
    await declareQueue('lost.missing', { 'x-dead-letter-exchange': 'lost.gone' });
    await declareExchange('lost.empty', 'fanout');
    await declareQueue('lost.unbound', { 'x-dead-letter-exchange': 'lost.empty' });

    // A cycle, through the default exchange.
    await declareQueue('cycle.a', { 'x-dead-letter-exchange': '', 'x-dead-letter-routing-key': 'cycle.b' });
    await declareQueue('cycle.b', { 'x-dead-letter-exchange': '', 'x-dead-letter-routing-key': 'cycle.a' });

    // MassTransit's convention.
    await declareQueue('billing');
    await declareQueue('billing_error');

    await declareQueue('bystander');

    app = await startApp({ profiles: [testProfile({ name: 'local' })] });
    const res = await app.get(mapPath);
    expect(res.status).toBe(200);
    map = res.body;
  });
  afterAll(async () => {
    await app?.close();
    await management(`/vhosts/${vhostPath}`, { method: 'DELETE' });
  });

  it('answers with exactly the queues and exchanges that take part, leaving the others out', () => {
    expect(map.nodes.map((n: any) => n.id)).toEqual([
      'exchange:',
      'exchange:chain.dlx',
      'exchange:chain.park',
      'exchange:e2e.first',
      'exchange:e2e.second',
      'exchange:lost.empty',
      'exchange:lost.gone',
      'queue:billing',
      'queue:billing_error',
      'queue:chain.dead',
      'queue:chain.parked',
      'queue:chain.work',
      'queue:cycle.a',
      'queue:cycle.b',
      'queue:e2e.dead',
      'queue:e2e.work',
      'queue:lost.missing',
      'queue:lost.unbound',
    ]);
  });

  it('shows a chain in order, with each queue\'s type and depth', () => {
    expect(map.edges).toEqual(
      expect.arrayContaining([
        { kind: 'dead_letter', from: 'queue:chain.work', to: 'exchange:chain.dlx', routingKey: 'dead', sources: ['chain.work'] },
        { kind: 'binding', from: 'exchange:chain.dlx', to: 'queue:chain.dead', bindingKey: 'dead', sources: ['chain.work'] },
        { kind: 'dead_letter', from: 'queue:chain.dead', to: 'exchange:chain.park', routingKey: null, sources: ['chain.dead'] },
        { kind: 'binding', from: 'exchange:chain.park', to: 'queue:chain.parked', bindingKey: '', sources: ['chain.dead'] },
      ]),
    );
    expect(map.nodes.find((n: any) => n.id === 'queue:chain.dead')).toMatchObject({ kind: 'queue', name: 'chain.dead', type: 'quorum', approximateMessages: 0, inCycle: false });
  });

  it('follows an exchange-to-exchange binding', () => {
    expect(map.edges).toEqual(
      expect.arrayContaining([
        { kind: 'binding', from: 'exchange:e2e.first', to: 'exchange:e2e.second', bindingKey: '', sources: ['e2e.work'] },
        { kind: 'binding', from: 'exchange:e2e.second', to: 'queue:e2e.dead', bindingKey: '', sources: ['e2e.work'] },
      ]),
    );
  });

  it('draws a missing exchange and an exchange with nothing bound as losses, next to their set-up warnings', () => {
    expect(map.edges.filter((e: any) => e.kind === 'drop')).toEqual([
      { kind: 'drop', from: 'exchange:lost.gone', reason: 'exchange_missing', sources: ['lost.missing'] },
      { kind: 'drop', from: 'exchange:lost.empty', reason: 'routes_nowhere', sources: ['lost.unbound'] },
    ]);
    expect(map.nodes.find((n: any) => n.id === 'exchange:lost.gone')).toMatchObject({ missing: true });
    const warnings = (id: string) => map.nodes.find((n: any) => n.id === id).setupWarnings.map((w: any) => w.code);
    expect(warnings('queue:lost.missing')).toContain('dead_letter_exchange_missing');
    expect(warnings('queue:lost.unbound')).toContain('dead_letter_unroutable');
  });

  it('flags a cycle on its nodes', () => {
    expect(map.cycles).toEqual([['exchange:', 'queue:cycle.a', 'queue:cycle.b']]);
    expect(map.nodes.filter((n: any) => n.inCycle).map((n: any) => n.id)).toEqual(['exchange:', 'queue:cycle.a', 'queue:cycle.b']);
  });

  it('marks the MassTransit _error edge as by convention', () => {
    expect(map.edges.filter((e: any) => e.kind === 'convention')).toEqual([{ kind: 'convention', from: 'queue:billing', to: 'queue:billing_error', sources: ['billing'] }]);
  });
});
