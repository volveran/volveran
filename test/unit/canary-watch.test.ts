// Where a Canary is watched: the queue it goes back to dead-letters through
// an exchange, and the watch queue is bound there with the bindings that
// route to the dead-letter queue (direct, fanout and topic only), or the
// Canary is unwatched, with the reason.
import { describe, expect, it } from 'vitest';
import { canaryWatchBindings } from '../../src/server/triage/canary-watch.js';
import type { VhostTopology } from '../../src/server/triage/setup-checks.js';

const topology = (type: string, bindings: Array<[string, string, string]>): VhostTopology => ({
  exchanges: new Map([
    ['orders.dlx', { type }],
    ['orders', { type: 'topic' }],
  ]),
  bindings: bindings.map(([source, destination, routingKey]) => ({ source, destination, destinationType: 'queue', routingKey })),
});
const work = (args: Record<string, unknown>, policy: Record<string, unknown> = {}) => ({
  name: 'orders.work',
  arguments: args,
  effectivePolicy: policy,
});

describe('canaryWatchBindings', () => {
  it('binds to the dead-letter exchange with every binding that routes to the dead-letter queue', () => {
    const vhost = topology('direct', [
      ['orders.dlx', 'orders.dlq', 'orders.created'],
      ['orders.dlx', 'orders.dlq', 'orders.cancelled'],
      ['orders.dlx', 'orders.parked', 'parked'],
      ['orders', 'orders.dlq', 'orders.created'],
    ]);
    expect(canaryWatchBindings({ source: work({ 'x-dead-letter-exchange': 'orders.dlx' }), deadLetterQueue: 'orders.dlq', topology: vhost })).toEqual({
      watchable: true,
      exchange: 'orders.dlx',
      routingKeys: ['orders.created', 'orders.cancelled'],
    });
  });

  it('takes the dead-letter exchange from a policy, and binds fanout and topic exchanges with their keys', () => {
    expect(
      canaryWatchBindings({
        source: work({}, { 'dead-letter-exchange': 'orders.dlx' }),
        deadLetterQueue: 'orders.dlq',
        topology: topology('fanout', [['orders.dlx', 'orders.dlq', '']]),
      }),
    ).toEqual({ watchable: true, exchange: 'orders.dlx', routingKeys: [''] });
    expect(
      canaryWatchBindings({
        source: work({ 'x-dead-letter-exchange': 'orders.dlx' }),
        deadLetterQueue: 'orders.dlq',
        topology: topology('topic', [['orders.dlx', 'orders.dlq', 'orders.#']]),
      }),
    ).toEqual({ watchable: true, exchange: 'orders.dlx', routingKeys: ['orders.#'] });
  });

  it('is unwatched for a headers dead-letter exchange', () => {
    const result = canaryWatchBindings({
      source: work({ 'x-dead-letter-exchange': 'orders.dlx' }),
      deadLetterQueue: 'orders.dlq',
      topology: topology('headers', [['orders.dlx', 'orders.dlq', '']]),
    });
    expect(result).toEqual({ watchable: false, reason: expect.stringContaining('headers exchange "orders.dlx"') });
  });

  it('is unwatched without a dead-letter exchange, through the default exchange, or with no binding to the dead-letter queue', () => {
    const vhost = topology('fanout', [['orders.dlx', 'orders.parked', '']]);
    const reason = (source: ReturnType<typeof work> | null) => {
      const result = canaryWatchBindings({ source, deadLetterQueue: 'orders.dlq', topology: vhost });
      return result.watchable ? null : result.reason;
    };
    expect(reason(work({}))).toContain('"orders.work" has no dead-letter exchange');
    expect(reason(work({ 'x-dead-letter-exchange': '', 'x-dead-letter-routing-key': 'orders.dlq' }))).toContain('default exchange');
    expect(reason(work({ 'x-dead-letter-exchange': 'gone' }))).toContain('"gone", which does not exist');
    expect(reason(work({ 'x-dead-letter-exchange': 'orders.dlx' }))).toContain('no binding to "orders.dlq"');
    expect(reason(null)).toContain('not known');
  });
});

describe('canaryWatchBindings for a MassTransit Replay', () => {
  const vhost = (exchanges: Array<[string, string]>, bindings: Array<[string, string, string]>): VhostTopology => ({
    exchanges: new Map(exchanges.map(([name, type]) => [name, { type }])),
    bindings: bindings.map(([source, destination, routingKey]) => ({ source, destination, destinationType: 'queue', routingKey })),
  });
  const input = { name: 'submit-order', arguments: {}, effectivePolicy: {} };

  it('binds to the _error exchange MassTransit publishes faults to, whatever the input queue dead-letters to', () => {
    const topology = vhost(
      [
        ['submit-order', 'fanout'],
        ['submit-order_error', 'fanout'],
      ],
      [
        ['submit-order', 'submit-order', ''],
        ['submit-order_error', 'submit-order_error', ''],
      ],
    );
    for (const source of [input, null]) {
      expect(
        canaryWatchBindings({ source, massTransitInputQueue: 'submit-order', deadLetterQueue: 'submit-order_error', topology }),
      ).toEqual({ watchable: true, exchange: 'submit-order_error', routingKeys: [''] });
    }
  });

  it('is unwatched when the _error exchange is missing or does not route to the Checkout queue', () => {
    const reason = (topology: VhostTopology) => {
      const result = canaryWatchBindings({
        source: input,
        massTransitInputQueue: 'submit-order',
        deadLetterQueue: 'submit-order_error',
        topology,
      });
      return result.watchable ? null : result.reason;
    };
    expect(reason(vhost([['submit-order', 'fanout']], []))).toContain('error exchange "submit-order_error", which does not exist');
    expect(reason(vhost([['submit-order_error', 'fanout']], [['submit-order_error', 'elsewhere', '']]))).toContain(
      'no binding to "submit-order_error"',
    );
  });
});
