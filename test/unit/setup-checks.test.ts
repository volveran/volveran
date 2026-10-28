// Dead-letter set-up checks: the warnings a queue gets from its arguments,
// policies and the exchanges of its vhost, and the vhost's count by severity.
import { describe, expect, it } from 'vitest';
import { countSetupWarnings, setupWarnings, type CheckedQueue, type VhostTopology } from '../../src/server/triage/setup-checks.js';

const vhost: VhostTopology = {
  exchanges: new Map([['dlx', { type: 'fanout' }]]),
  bindings: [{ source: 'dlx', destination: 'orders.dlq', destinationType: 'queue', routingKey: '' }],
};
const codes = (q: CheckedQueue) => setupWarnings(q, vhost).map((w) => w.code);

describe('the delivery-limit check', () => {
  const quorumDlq: CheckedQueue = {
    name: 'orders.dlq',
    deadLetterQueue: true,
    type: 'quorum',
    arguments: { 'x-queue-type': 'quorum' },
    effectivePolicy: {},
    deliveryLimit: 20,
  };

  it('warns that a quorum dead-letter queue with the default delivery limit and no dead-letter exchange drops Messages', () => {
    expect(setupWarnings(quorumDlq, vhost)).toEqual([
      {
        code: 'messages_dropped_at_delivery_limit',
        severity: 'loses_messages',
        deliveryLimit: 20,
        message: expect.stringMatching(/no dead-letter exchange.*dropped.*delivery-limit = -1.*dead-letter exchange/is),
      },
    ]);
  });

  it('also warns about a delivery limit set by an argument or a policy, naming that limit', () => {
    const [warning] = setupWarnings({ ...quorumDlq, arguments: { 'x-delivery-limit': 5 }, deliveryLimit: 5 }, vhost);
    expect(warning).toMatchObject({ deliveryLimit: 5, message: expect.stringContaining('a delivery-limit of 5') });
    expect(setupWarnings({ ...quorumDlq, effectivePolicy: { 'delivery-limit': 3 }, deliveryLimit: 3 }, vhost)).toEqual([
      expect.objectContaining({ deliveryLimit: 3 }),
    ]);
  });

  it('does not warn when the queue has a dead-letter exchange that exists, by argument or by policy', () => {
    expect(codes({ ...quorumDlq, arguments: { 'x-dead-letter-exchange': 'dlx' } })).toEqual([]);
    expect(codes({ ...quorumDlq, effectivePolicy: { 'dead-letter-exchange': 'dlx' } })).toEqual([]);
    expect(codes({ ...quorumDlq, arguments: { 'x-dead-letter-exchange': '', 'x-dead-letter-routing-key': 'parked' } })).toEqual([]);
  });

  it('still warns when the dead-letter exchange does not exist, alongside the missing exchange warning', () => {
    const warnings = setupWarnings({ ...quorumDlq, arguments: { 'x-dead-letter-exchange': 'gone' } }, vhost);
    expect(warnings.map((w) => w.code)).toEqual(['messages_dropped_at_delivery_limit', 'dead_letter_exchange_missing']);
    expect(warnings[0]!.message).toContain('a dead-letter exchange that does not exist ("gone")');
  });

  it('does not warn when the delivery limit is unlimited (the API reports "unlimited", read as null)', () => {
    expect(codes({ ...quorumDlq, effectivePolicy: { 'delivery-limit': -1 }, deliveryLimit: null })).toEqual([]);
    expect(codes({ ...quorumDlq, deliveryLimit: -1 })).toEqual([]);
  });

  it('only checks quorum dead-letter queues', () => {
    expect(codes({ ...quorumDlq, deadLetterQueue: false })).toEqual([]);
    expect(codes({ ...quorumDlq, type: 'classic', deliveryLimit: null })).toEqual([]);
  });
});

describe('the missing dead-letter exchange check', () => {
  const work: CheckedQueue = {
    name: 'orders.work',
    deadLetterQueue: false,
    type: 'classic',
    arguments: { 'x-dead-letter-exchange': 'gone' },
    effectivePolicy: {},
    deliveryLimit: null,
  };

  it('warns about any queue whose dead-letter exchange does not exist, naming the exchange and the fix', () => {
    expect(setupWarnings(work, vhost)).toEqual([
      {
        code: 'dead_letter_exchange_missing',
        severity: 'loses_messages',
        deadLetterExchange: 'gone',
        message: expect.stringMatching(/"gone", which does not exist.*dropped.*Declare the exchange "gone"/is),
      },
    ]);
  });

  it('reads the exchange from a policy too, the queue argument winning over it', () => {
    expect(codes({ ...work, arguments: {}, effectivePolicy: { 'dead-letter-exchange': 'gone' } })).toEqual(['dead_letter_exchange_missing']);
    expect(codes({ ...work, arguments: { 'x-dead-letter-exchange': 'dlx' }, effectivePolicy: { 'dead-letter-exchange': 'gone' } })).toEqual([]);
    expect(setupWarnings({ ...work, effectivePolicy: { 'dead-letter-exchange': 'dlx' } }, vhost)).toEqual([
      expect.objectContaining({ deadLetterExchange: 'gone' }),
    ]);
  });

  it('never warns about the default exchange, nor about a queue without a dead-letter exchange', () => {
    expect(codes({ ...work, arguments: { 'x-dead-letter-exchange': '' } })).toEqual([]);
    expect(codes({ ...work, arguments: {} })).toEqual([]);
  });
});

describe('the unroutable dead-letter exchange check', () => {
  const work: CheckedQueue = {
    name: 'orders.work',
    deadLetterQueue: false,
    type: 'classic',
    arguments: { 'x-dead-letter-exchange': 'dlx', 'x-dead-letter-routing-key': 'parked' },
    effectivePolicy: {},
    deliveryLimit: null,
  };
  type Binding = VhostTopology['bindings'][number];
  type Exchange = { type: string; alternateExchange?: string };
  const toQueue = (source: string, routingKey: string, destination = 'orders.dlq'): Binding => ({ source, destination, destinationType: 'queue', routingKey });
  const toExchange = (source: string, routingKey: string, destination: string): Binding => ({ source, destination, destinationType: 'exchange', routingKey });
  const topology = (dlx: string | Exchange, bindings: Binding[], more: Array<[string, Exchange]> = []): VhostTopology => ({
    exchanges: new Map([['dlx', typeof dlx === 'string' ? { type: dlx } : dlx], ...more]),
    bindings,
  });
  const unroutable = (q: CheckedQueue, t: VhostTopology) => setupWarnings(q, t).some((w) => w.code === 'dead_letter_unroutable');

  it('warns when no binding of a direct dead-letter exchange routes the dead-letter routing key, naming the exchange, the key and the fix', () => {
    expect(setupWarnings(work, topology('direct', [toQueue('dlx', 'other')]))).toEqual([
      {
        code: 'dead_letter_unroutable',
        severity: 'loses_messages',
        deadLetterExchange: 'dlx',
        routingKey: 'parked',
        message: expect.stringMatching(/"dlx".*routing key "parked".*dropped.*Bind a queue to "dlx" with "parked".*alternate exchange/is),
      },
    ]);
    expect(unroutable(work, topology('direct', [toQueue('dlx', 'parked')]))).toBe(false);
  });

  it('routes every key through a fanout exchange with any binding to a queue', () => {
    expect(unroutable(work, topology('fanout', [toQueue('dlx', 'whatever')]))).toBe(false);
    expect(unroutable(work, topology('fanout', []))).toBe(true);
  });

  it('matches topic bindings word by word, "*" standing for exactly one word and "#" for zero or more', () => {
    const withKey = (routingKey: string) => ({ ...work, arguments: { 'x-dead-letter-exchange': 'dlx', 'x-dead-letter-routing-key': routingKey } });
    const routed = (routingKey: string, bindingKey: string) => !unroutable(withKey(routingKey), topology('topic', [toQueue('dlx', bindingKey)]));
    expect(routed('dead.orders', 'dead.orders')).toBe(true);
    expect(routed('dead.orders', 'dead.*')).toBe(true);
    expect(routed('dead.orders.eu', 'dead.*')).toBe(false);
    expect(routed('dead', 'dead.*')).toBe(false);
    expect(routed('dead.orders.eu', 'dead.#')).toBe(true);
    expect(routed('dead', 'dead.#')).toBe(true);
    expect(routed('dead.orders.eu', '#.eu')).toBe(true);
    expect(routed('dead.orders.eu', '*.eu')).toBe(false);
    expect(routed('anything.at.all', '#')).toBe(true);
    expect(routed('dead.orders.eu', 'dead.#.eu')).toBe(true);
    expect(routed('dead.eu', 'dead.#.eu')).toBe(true);
    expect(routed('parked', 'dead.#')).toBe(false);
    expect(routed('dead.orders', 'dead.order')).toBe(false);
  });

  it('does not warn when the dead-letter exchange has an alternate exchange', () => {
    expect(unroutable(work, topology({ type: 'direct', alternateExchange: 'unrouted' }, []))).toBe(false);
  });

  it('follows exchange-to-exchange bindings, matching the key at each exchange and stopping at cycles', () => {
    const regional: Array<[string, Exchange]> = [['dead.regional', { type: 'topic' }]];
    expect(unroutable(work, topology('direct', [toExchange('dlx', 'parked', 'dead.regional'), toQueue('dead.regional', 'parked.#')], regional))).toBe(false);
    expect(unroutable(work, topology('direct', [toExchange('dlx', 'parked', 'dead.regional'), toQueue('dead.regional', 'other.#')], regional))).toBe(true);
    expect(unroutable(work, topology('direct', [toExchange('dlx', 'other', 'dead.regional'), toQueue('dead.regional', '#')], regional))).toBe(true);
    expect(unroutable(work, topology('direct', [toExchange('dlx', 'parked', 'dead.regional'), toExchange('dead.regional', '#', 'dlx')], regional))).toBe(true);
  });

  it('never warns about a headers exchange, or one of a plugin\'s type, whose routing bindings alone cannot decide', () => {
    expect(unroutable(work, topology('headers', []))).toBe(false);
    expect(unroutable(work, topology('x-consistent-hash', []))).toBe(false);
    expect(unroutable(work, topology('direct', [toExchange('dlx', 'parked', 'by-headers')], [['by-headers', { type: 'headers' }]]))).toBe(false);
  });

  it('never warns about the default exchange, a missing exchange or a queue without a dead-letter exchange', () => {
    expect(unroutable({ ...work, arguments: { 'x-dead-letter-exchange': '', 'x-dead-letter-routing-key': 'nowhere' } }, topology('direct', []))).toBe(false);
    expect(unroutable({ ...work, arguments: { 'x-dead-letter-exchange': 'gone' } }, topology('direct', []))).toBe(false);
    expect(unroutable({ ...work, arguments: {} }, topology('direct', []))).toBe(false);
  });

  it('reads the dead-letter exchange and routing key from a policy too', () => {
    const byPolicy = { ...work, arguments: {}, effectivePolicy: { 'dead-letter-exchange': 'dlx', 'dead-letter-routing-key': 'parked' } };
    expect(unroutable(byPolicy, topology('direct', [toQueue('dlx', 'other')]))).toBe(true);
    expect(unroutable(byPolicy, topology('direct', [toQueue('dlx', 'parked')]))).toBe(false);
  });

  it('without a dead-letter routing key, warns only when none of the keys the queue is bound with routes', () => {
    const keyless = { ...work, arguments: { 'x-dead-letter-exchange': 'dlx' } };
    const intoWork = [toQueue('orders', 'order.created', 'orders.work'), toQueue('orders', 'order.paid', 'orders.work')];
    const orders: Array<[string, Exchange]> = [['orders', { type: 'direct' }]];
    expect(setupWarnings(keyless, topology('direct', [...intoWork, toQueue('dlx', 'order.shipped')], orders))).toEqual([
      expect.objectContaining({
        code: 'dead_letter_unroutable',
        routingKey: null,
        message: expect.stringMatching(/"dlx".*routing keys it received.*"order\.created", "order\.paid"/is),
      }),
    ]);
    expect(unroutable(keyless, topology('direct', [...intoWork, toQueue('dlx', 'order.paid')], orders))).toBe(false);
  });

  it('without a dead-letter routing key, does not warn when the keys the queue receives cannot be known', () => {
    const keyless = { ...work, arguments: { 'x-dead-letter-exchange': 'dlx' } };
    const fromFanout = topology('direct', [toQueue('events', '', 'orders.work')], [['events', { type: 'fanout' }]]);
    const fromTopicWildcard = topology('direct', [toQueue('events', 'order.*', 'orders.work')], [['events', { type: 'topic' }]]);
    const fromTopicLiteral = topology('direct', [toQueue('events', 'order.paid', 'orders.work')], [['events', { type: 'topic' }]]);
    expect(unroutable(keyless, fromFanout)).toBe(false);
    expect(unroutable(keyless, fromTopicWildcard)).toBe(false);
    expect(unroutable(keyless, fromTopicLiteral)).toBe(true);
  });

  it('counts the queue\'s own name as a key it receives, through the default exchange', () => {
    const keyless = { ...work, arguments: { 'x-dead-letter-exchange': 'dlx' } };
    expect(unroutable(keyless, topology('direct', [toQueue('dlx', 'orders.work')]))).toBe(false);
    expect(unroutable(keyless, topology('direct', []))).toBe(true);
  });
});

describe('countSetupWarnings', () => {
  it('counts the warnings of every queue by severity', () => {
    const lost = { severity: 'loses_messages', message: '', code: 'dead_letter_exchange_missing', deadLetterExchange: 'x' } as const;
    expect(countSetupWarnings([[lost, lost], [], [lost]])).toEqual({ loses_messages: 3, may_lose_messages: 0 });
    expect(countSetupWarnings([])).toEqual({ loses_messages: 0, may_lose_messages: 0 });
  });
});
