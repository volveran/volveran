// The queue list: name filters, dead-letter sources, ordering, which queue
// types can be checked out, and the dead-letter set-up warning.
import { describe, expect, it } from 'vitest';
import {
  arrangeQueues,
  checkoutAvailability,
  deadLetterSetupWarning,
  deadLetterSources,
  matchesQueueFilter,
  type Binding,
  type DeadLetterSettings,
} from '../../src/server/triage/queue-list.js';

describe('matchesQueueFilter', () => {
  it.each([
    ['*.dlq', 'orders.dlq', true],
    ['*.dlq', 'billing.payments.dlq', true],
    ['*.dlq', 'orders.dlq.archive', false],
    ['*.dlq', 'orders-dlq', false],
    ['dlq.*', 'dlq.orders', true],
    ['*dlq*', 'my-dlq-queue', true],
    ['orders.?lq', 'orders.dlq', true],
    ['orders.?lq', 'orders.dlqq', false],
    ['orders.dlq', 'orders.dlq', true],
    ['orders.dlq', 'ordersXdlq', false],
    ['*.(dlq)', 'a.(dlq)', true],
  ])('pattern %s against %s is %s', (pattern, name, expected) => {
    expect(matchesQueueFilter(name, pattern)).toBe(expected);
  });
});

const queue = (name: string, args: Record<string, unknown> = {}, policy: Record<string, unknown> = {}): DeadLetterSettings => ({
  name,
  arguments: args,
  effectivePolicy: policy,
});
const toQueue = (source: string, destination: string): Binding => ({ source, destination, destinationType: 'queue' });

describe('deadLetterSources', () => {
  it('follows a dead-letter exchange argument to every queue bound to the exchange', () => {
    const sources = deadLetterSources(
      [queue('orders.work', { 'x-dead-letter-exchange': 'orders.dlx' }), queue('orders.dlq'), queue('orders.dlq.quorum')],
      [toQueue('orders', 'orders.work'), toQueue('orders.dlx', 'orders.dlq'), toQueue('orders.dlx', 'orders.dlq.quorum')],
    );
    expect(Object.fromEntries(sources)).toEqual({ 'orders.dlq': ['orders.work'], 'orders.dlq.quorum': ['orders.work'] });
  });

  it('follows a dead-letter exchange set by a policy', () => {
    const sources = deadLetterSources(
      [queue('a.work', {}, { 'dead-letter-exchange': 'dlx' }), queue('a.dlq')],
      [toQueue('dlx', 'a.dlq')],
    );
    expect(sources.get('a.dlq')).toEqual(['a.work']);
  });

  it('uses the dead-letter routing key as the queue name for the default exchange', () => {
    const sources = deadLetterSources(
      [queue('a.work', { 'x-dead-letter-exchange': '', 'x-dead-letter-routing-key': 'a.dlq' }), queue('a.dlq')],
      [],
    );
    expect(sources.get('a.dlq')).toEqual(['a.work']);
  });

  it('ignores the default exchange without a dead-letter routing key', () => {
    expect(deadLetterSources([queue('a.work', { 'x-dead-letter-exchange': '' })], []).size).toBe(0);
  });

  it('follows exchange-to-exchange bindings, without looping on cycles', () => {
    const sources = deadLetterSources(
      [queue('w', { 'x-dead-letter-exchange': 'x1' })],
      [
        { source: 'x1', destination: 'x2', destinationType: 'exchange' },
        { source: 'x2', destination: 'x1', destinationType: 'exchange' },
        toQueue('x2', 'deep.dlq'),
      ],
    );
    expect(sources.get('deep.dlq')).toEqual(['w']);
  });

  it('lists several sources of one dead-letter queue once each, by name', () => {
    const sources = deadLetterSources(
      [
        queue('b.work', { 'x-dead-letter-exchange': 'dlx' }, { 'dead-letter-exchange': 'dlx' }),
        queue('a.work', { 'x-dead-letter-exchange': 'dlx' }),
      ],
      [toQueue('dlx', 'all.dlq')],
    );
    expect(sources.get('all.dlq')).toEqual(['a.work', 'b.work']);
  });
});

describe('arrangeQueues', () => {
  const queues = [{ name: 'orders.work' }, { name: 'payments.dlq' }, { name: 'audit' }, { name: 'orders.dlq' }, { name: 'parked' }];
  const deadLetterSources = new Map([['parked', ['orders.dlq']]]);

  it('lists dead-letter queues first, by filter or because queues dead-letter into them, each group by name', () => {
    const result = arrangeQueues(queues, { defaultQueueFilter: '*.dlq', deadLetterSources });
    expect(result.map((q) => [q.name, q.deadLetterQueue, q.matchesDefaultFilter, q.deadLetteredFrom])).toEqual([
      ['orders.dlq', true, true, []],
      ['parked', true, false, ['orders.dlq']],
      ['payments.dlq', true, true, []],
      ['audit', false, false, []],
      ['orders.work', false, false, []],
    ]);
  });

  it('sorts by name when there are no dead-letter queues', () => {
    const result = arrangeQueues(queues, { deadLetterSources: new Map() });
    expect(result.map((q) => q.name)).toEqual(['audit', 'orders.dlq', 'orders.work', 'parked', 'payments.dlq']);
  });

  it('keeps only dead-letter queues on request', () => {
    const result = arrangeQueues(queues, { defaultQueueFilter: '*.dlq', deadLetterSources, onlyDeadLetterQueues: true });
    expect(result.map((q) => q.name)).toEqual(['orders.dlq', 'parked', 'payments.dlq']);
  });

  it('narrows by a case-insensitive substring search on the name', () => {
    const result = arrangeQueues(queues, { defaultQueueFilter: '*.dlq', deadLetterSources, search: 'ORDERS' });
    expect(result.map((q) => q.name)).toEqual(['orders.dlq', 'orders.work']);
  });

  it('treats a blank search as no search', () => {
    expect(arrangeQueues(queues, { deadLetterSources, search: '   ' })).toHaveLength(5);
  });

  it('keeps the other fields of each queue', () => {
    const [first] = arrangeQueues([{ name: 'a', approximateMessages: 7 }], { deadLetterSources: new Map() });
    expect(first).toEqual({ name: 'a', approximateMessages: 7, deadLetterQueue: false, matchesDefaultFilter: false, deadLetteredFrom: [] });
  });
});

describe('checkoutAvailability', () => {
  it.each(['classic', 'quorum'])('allows a Checkout on %s queues', (type) => {
    expect(checkoutAvailability(type)).toEqual({ available: true });
  });

  it('refuses a Checkout on stream queues and explains why', () => {
    expect(checkoutAvailability('stream')).toEqual({
      available: false,
      reason: expect.stringMatching(/^Stream queues cannot be checked out.*classic and quorum/is),
    });
  });

  it('refuses a Checkout on unknown queue types', () => {
    expect(checkoutAvailability('rabbit_mqtt_qos0_queue')).toEqual({
      available: false,
      reason: expect.stringContaining('"rabbit_mqtt_qos0_queue"'),
    });
  });
});

describe('deadLetterSetupWarning', () => {
  const quorumDlq = {
    deadLetterQueue: true,
    type: 'quorum',
    arguments: { 'x-queue-type': 'quorum' },
    effectivePolicy: {},
    deliveryLimit: 20,
  };

  it('warns that a quorum dead-letter queue with the default delivery limit and no dead-letter exchange drops Messages', () => {
    expect(deadLetterSetupWarning(quorumDlq)).toEqual({
      code: 'messages_dropped_at_delivery_limit',
      deliveryLimit: 20,
      message: expect.stringMatching(/dropped.*delivery-limit = -1.*dead-letter exchange/is),
    });
  });

  it('also warns about a delivery limit set by an argument or a policy, naming that limit', () => {
    const warning = deadLetterSetupWarning({ ...quorumDlq, arguments: { 'x-delivery-limit': 5 }, deliveryLimit: 5 });
    expect(warning).toMatchObject({ deliveryLimit: 5, message: expect.stringContaining('a delivery-limit of 5') });
    expect(deadLetterSetupWarning({ ...quorumDlq, effectivePolicy: { 'delivery-limit': 3 }, deliveryLimit: 3 })).toMatchObject({
      deliveryLimit: 3,
    });
  });

  it('does not warn when the queue has a dead-letter exchange, by argument or by policy', () => {
    expect(deadLetterSetupWarning({ ...quorumDlq, arguments: { 'x-dead-letter-exchange': 'dlx' } })).toBeNull();
    expect(deadLetterSetupWarning({ ...quorumDlq, effectivePolicy: { 'dead-letter-exchange': 'dlx' } })).toBeNull();
  });

  it('does not warn when the delivery limit is unlimited (the API reports "unlimited", read as null)', () => {
    expect(deadLetterSetupWarning({ ...quorumDlq, effectivePolicy: { 'delivery-limit': -1 }, deliveryLimit: null })).toBeNull();
    expect(deadLetterSetupWarning({ ...quorumDlq, deliveryLimit: -1 })).toBeNull();
  });

  it('only checks quorum dead-letter queues', () => {
    expect(deadLetterSetupWarning({ ...quorumDlq, deadLetterQueue: false })).toBeNull();
    expect(deadLetterSetupWarning({ ...quorumDlq, type: 'classic', deliveryLimit: null })).toBeNull();
  });
});
