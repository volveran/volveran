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
    // Only the at-most-once notice of a quorum queue that dead-letters.
    const notice = ['quorum_at_most_once_dead_lettering'];
    expect(codes({ ...quorumDlq, arguments: { 'x-dead-letter-exchange': 'dlx' } })).toEqual(notice);
    expect(codes({ ...quorumDlq, effectivePolicy: { 'dead-letter-exchange': 'dlx' } })).toEqual(notice);
    expect(codes({ ...quorumDlq, arguments: { 'x-dead-letter-exchange': '', 'x-dead-letter-routing-key': 'parked' } })).toEqual(notice);
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

describe('the dead-letter queue drops Messages check', () => {
  const dlq: CheckedQueue = {
    name: 'orders.dlq',
    deadLetterQueue: true,
    type: 'classic',
    arguments: {},
    effectivePolicy: {},
    deliveryLimit: null,
  };
  const drops = (q: CheckedQueue) => setupWarnings(q, vhost).filter((w) => w.code === 'dead_letter_queue_drops_messages');

  it('warns that a message TTL on a dead-letter queue without a dead-letter exchange of its own drops Messages, naming the TTL', () => {
    expect(setupWarnings({ ...dlq, arguments: { 'x-message-ttl': 60_000 } }, vhost)).toEqual([
      {
        code: 'dead_letter_queue_drops_messages',
        severity: 'loses_messages',
        settings: ['message-ttl'],
        message: expect.stringMatching(/message TTL of 60000 ms.*dropped.*Remove the message TTL.*dead-letter exchange/is),
      },
    ]);
  });

  it('warns about a length limit with the drop-head overflow, which is the default', () => {
    expect(drops({ ...dlq, arguments: { 'x-max-length': 1000 } })).toEqual([
      expect.objectContaining({ settings: ['max-length'], message: expect.stringMatching(/length limit of 1000 Messages.*drop-head.*oldest/is) }),
    ]);
    expect(drops({ ...dlq, arguments: { 'x-max-length-bytes': 4096, 'x-overflow': 'drop-head' } })).toEqual([
      expect.objectContaining({ settings: ['max-length-bytes'], message: expect.stringContaining('length limit of 4096 bytes') }),
    ]);
  });

  it('does not warn about a length limit whose overflow rejects new Messages instead', () => {
    expect(drops({ ...dlq, arguments: { 'x-max-length': 1000, 'x-overflow': 'reject-publish' } })).toEqual([]);
    expect(drops({ ...dlq, effectivePolicy: { 'max-length': 1000, overflow: 'reject-publish-dlx' } })).toEqual([]);
    // The queue argument wins over the policy's overflow.
    expect(drops({ ...dlq, arguments: { 'x-overflow': 'drop-head' }, effectivePolicy: { 'max-length': 10, overflow: 'reject-publish' } })).toEqual([
      expect.objectContaining({ settings: ['max-length'] }),
    ]);
  });

  it('reads the settings from a policy too, naming the lower value when both set one', () => {
    expect(drops({ ...dlq, effectivePolicy: { 'message-ttl': 5000 } })).toEqual([
      expect.objectContaining({ message: expect.stringContaining('message TTL of 5000 ms') }),
    ]);
    expect(drops({ ...dlq, arguments: { 'x-message-ttl': 9000 }, effectivePolicy: { 'message-ttl': 5000 } })).toEqual([
      expect.objectContaining({ message: expect.stringContaining('message TTL of 5000 ms') }),
    ]);
  });

  it('does not warn about a TTL or a length limit when the queue dead-letters onward to an exchange that exists', () => {
    const settings = { 'x-message-ttl': 1000, 'x-max-length': 10 };
    expect(drops({ ...dlq, arguments: { ...settings, 'x-dead-letter-exchange': 'dlx' } })).toEqual([]);
    expect(drops({ ...dlq, arguments: settings, effectivePolicy: { 'dead-letter-exchange': 'dlx' } })).toEqual([]);
    expect(drops({ ...dlq, arguments: { ...settings, 'x-dead-letter-exchange': 'gone' } })).toEqual([
      expect.objectContaining({ settings: ['message-ttl', 'max-length'] }),
    ]);
  });

  it('warns about a queue expiry even with a dead-letter exchange: the expired queue is deleted with its Messages, none dead-lettered', () => {
    expect(drops({ ...dlq, arguments: { 'x-expires': 3_600_000, 'x-dead-letter-exchange': 'dlx' } })).toEqual([
      expect.objectContaining({ settings: ['expires'], message: expect.stringMatching(/expires after 3600000 ms unused.*deleted.*not dead-letter.*Remove the queue expiry/is) }),
    ]);
    expect(drops({ ...dlq, effectivePolicy: { expires: 60_000 } })).toEqual([expect.objectContaining({ settings: ['expires'] })]);
  });

  it('names every setting that drops Messages in one warning', () => {
    const [warning] = drops({ ...dlq, arguments: { 'x-message-ttl': 1, 'x-expires': 2, 'x-max-length': 3 } });
    expect(warning!.settings).toEqual(['message-ttl', 'expires', 'max-length']);
    expect(warning!.message).toMatch(/message TTL of 1 ms.*expires after 2 ms.*length limit of 3 Messages/is);
  });

  it('only checks dead-letter queues', () => {
    expect(drops({ ...dlq, deadLetterQueue: false, arguments: { 'x-message-ttl': 1000 } })).toEqual([]);
    expect(drops(dlq)).toEqual([]);
  });
});

describe('the quorum at-most-once dead-lettering check', () => {
  const work: CheckedQueue = {
    name: 'payments.work',
    deadLetterQueue: false,
    type: 'quorum',
    arguments: { 'x-queue-type': 'quorum', 'x-dead-letter-exchange': 'dlx' },
    effectivePolicy: {},
    deliveryLimit: 20,
  };

  it('notes that a quorum queue dead-lettering with the default at-most-once strategy can lose Messages, and how to fix it', () => {
    expect(setupWarnings(work, vhost)).toEqual([
      {
        code: 'quorum_at_most_once_dead_lettering',
        severity: 'may_lose_messages',
        message: expect.stringMatching(/at-most-once.*lost.*at-least-once.*reject-publish/is),
      },
    ]);
    expect(codes({ ...work, arguments: { 'x-dead-letter-strategy': 'at-most-once', 'x-dead-letter-exchange': '' } })).toEqual([
      'quorum_at_most_once_dead_lettering',
    ]);
  });

  it('does not note a queue that dead-letters at-least-once with reject-publish overflow, by argument or by policy', () => {
    const safe = { 'dead-letter-strategy': 'at-least-once', overflow: 'reject-publish' };
    expect(codes({ ...work, arguments: { ...work.arguments, 'x-dead-letter-strategy': 'at-least-once', 'x-overflow': 'reject-publish' } })).toEqual([]);
    expect(codes({ ...work, effectivePolicy: safe })).toEqual([]);
    // The queue argument wins over the policy's strategy.
    expect(codes({ ...work, arguments: { ...work.arguments, 'x-dead-letter-strategy': 'at-most-once' }, effectivePolicy: safe })).toEqual([
      'quorum_at_most_once_dead_lettering',
    ]);
  });

  it('notes at-least-once without reject-publish overflow, which falls back to at-most-once', () => {
    expect(setupWarnings({ ...work, arguments: { ...work.arguments, 'x-dead-letter-strategy': 'at-least-once' } }, vhost)).toEqual([
      expect.objectContaining({ code: 'quorum_at_most_once_dead_lettering', message: expect.stringMatching(/overflow.*falls back to at-most-once/is) }),
    ]);
  });

  it('only checks quorum queues that dead-letter to an exchange that exists', () => {
    expect(codes({ ...work, type: 'classic', deliveryLimit: null })).toEqual([]);
    expect(codes({ ...work, arguments: { 'x-queue-type': 'quorum' } })).toEqual([]);
    // A missing exchange loses the Message whatever the strategy: that warning covers it.
    expect(codes({ ...work, arguments: { 'x-dead-letter-exchange': 'gone' } })).toEqual(['dead_letter_exchange_missing']);
  });

  it('lists it after the warnings that lose Messages', () => {
    expect(codes({ ...work, deadLetterQueue: true, arguments: { ...work.arguments, 'x-expires': 1000 } })).toEqual([
      'dead_letter_queue_drops_messages',
      'quorum_at_most_once_dead_lettering',
    ]);
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
