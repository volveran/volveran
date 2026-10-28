// Dead-letter set-up checks: the warnings a queue gets from its arguments,
// policies and the exchanges of its vhost, and the vhost's count by severity.
import { describe, expect, it } from 'vitest';
import { countSetupWarnings, setupWarnings, type CheckedQueue, type VhostTopology } from '../../src/server/triage/setup-checks.js';

const vhost: VhostTopology = { exchanges: new Map([['dlx', { type: 'fanout' }]]), bindings: [] };
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

describe('countSetupWarnings', () => {
  it('counts the warnings of every queue by severity', () => {
    const lost = { severity: 'loses_messages', message: '', code: 'dead_letter_exchange_missing', deadLetterExchange: 'x' } as const;
    expect(countSetupWarnings([[lost, lost], [], [lost]])).toEqual({ loses_messages: 3, may_lose_messages: 0 });
    expect(countSetupWarnings([])).toEqual({ loses_messages: 0, may_lose_messages: 0 });
  });
});
