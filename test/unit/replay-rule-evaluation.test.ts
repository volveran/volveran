// What a Rule Pass makes of one held Message: Replay it, its attempts are
// used up, its back-off has not passed yet, or the rule does not select it.
import { describe, expect, it } from 'vitest';
import { evaluateRule, type RuleMessage } from '../../src/server/replay-rules/evaluate.js';
import type { ReplayRule } from '../../src/shared/replay-rules.js';

const MINUTE = 60_000;
const NOW = new Date('2026-10-29T12:00:00.000Z');
const minutesAgo = (n: number) => new Date(NOW.getTime() - n * MINUTE);
/** An x-death `time` as amqplib decodes it: seconds since the epoch. */
const xDeathAt = (at: Date) => [{ queue: 'orders.work', reason: 'rejected', count: 1, time: at.getTime() / 1000 }];

const rule: ReplayRule = {
  name: 'db-timeouts',
  vhost: '/',
  queue: 'orders.dlq',
  filter: [{ kind: 'routing-key', value: 'orders.*' }],
  everyMs: 5 * MINUTE,
  maxPerPass: 100,
  rate: 10,
  backoff: { initialMs: MINUTE, multiplier: 2, maxMs: 10 * MINUTE },
  maxAttempts: 5,
  whenAttemptsUsedUp: 'keep',
  stopWhen: { diedAgain: 10, withinMs: 15 * MINUTE },
  startPaused: false,
};

const message = (headers: Record<string, unknown>, diedAgainCount = 0, routingKey = 'orders.created'): RuleMessage => ({
  delivery: {
    fields: { exchange: '', routingKey, redelivered: false },
    properties: { headers },
    content: Buffer.from('{}'),
  },
  diedAgainCount,
});

const verdict = (m: RuleMessage, r: ReplayRule = rule) => evaluateRule(r, m, NOW).verdict;

describe('evaluateRule', () => {
  it('is no_match for a Message the filter does not select, whatever its attempts', () => {
    expect(verdict(message({ 'x-death': xDeathAt(minutesAgo(60)) }, 0, 'payments.created'))).toBe('no_match');
    expect(verdict(message({ 'x-death': xDeathAt(minutesAgo(60)) }, 9, 'payments.created'))).toBe('no_match');
  });

  it('selects every Message without a filter', () => {
    expect(verdict(message({ 'x-death': xDeathAt(minutesAgo(60)) }, 0, 'payments.created'), { ...rule, filter: null })).toBe('replay');
  });

  it('is replay once the first delay (initial) has passed since the dead-lettering, not_due before', () => {
    expect(verdict(message({ 'x-death': xDeathAt(minutesAgo(1)) }))).toBe('replay');
    expect(verdict(message({ 'x-death': xDeathAt(new Date(NOW.getTime() - MINUTE + 1000)) }))).toBe('not_due');
  });

  it('grows the delay by the multiplier with each attempt (the Died Again count)', () => {
    // Attempt 2: 1 min × 2² = 4 min.
    expect(verdict(message({ 'x-death': xDeathAt(minutesAgo(3)) }, 2))).toBe('not_due');
    expect(verdict(message({ 'x-death': xDeathAt(minutesAgo(4)) }, 2))).toBe('replay');
    expect(evaluateRule(rule, message({ 'x-death': xDeathAt(minutesAgo(3)) }, 2), NOW)).toEqual({
      verdict: 'not_due',
      attempts: 2,
      nextAttemptAt: minutesAgo(-1),
    });
  });

  it('caps the delay at max', () => {
    // Attempt 4: 1 min × 2⁴ = 16 min, capped at 10.
    expect(verdict(message({ 'x-death': xDeathAt(minutesAgo(9)) }, 4))).toBe('not_due');
    expect(verdict(message({ 'x-death': xDeathAt(minutesAgo(10)) }, 4))).toBe('replay');
  });

  it('is used_up once the attempts reach maxAttempts, due or not', () => {
    expect(verdict(message({ 'x-death': xDeathAt(minutesAgo(60)) }, 5))).toBe('used_up');
    expect(verdict(message({ 'x-death': xDeathAt(NOW) }, 7))).toBe('used_up');
    expect(evaluateRule(rule, message({ 'x-death': xDeathAt(NOW) }, 7), NOW)).toEqual({
      verdict: 'used_up',
      attempts: 7,
      nextAttemptAt: null,
    });
  });

  it('measures from the most recent x-death entry', () => {
    const headers = {
      'x-death': [
        { queue: 'orders.retry', reason: 'expired', count: 3, time: minutesAgo(30).getTime() / 1000 },
        { queue: 'orders.work', reason: 'rejected', count: 1, time: minutesAgo(0.5).getTime() / 1000 },
      ],
    };
    expect(verdict(message(headers))).toBe('not_due');
  });

  it("falls back to the Failure Details' fault time without x-death", () => {
    const mt = (at: Date) => ({ 'MT-Reason': 'fault', 'MT-Fault-Timestamp': at.toISOString() });
    expect(verdict(message(mt(minutesAgo(0.5))))).toBe('not_due');
    expect(verdict(message(mt(minutesAgo(2))))).toBe('replay');
  });

  it('prefers x-death to the fault time', () => {
    const headers = { 'x-death': xDeathAt(minutesAgo(0.5)), 'MT-Reason': 'fault', 'MT-Fault-Timestamp': minutesAgo(60).toISOString() };
    expect(verdict(message(headers))).toBe('not_due');
  });

  it('counts a Message with no time at all as due', () => {
    expect(evaluateRule(rule, message({}), NOW)).toEqual({ verdict: 'replay', attempts: 0, nextAttemptAt: NOW });
    expect(verdict(message({ 'MT-Reason': 'fault', 'MT-Fault-Timestamp': 'last tuesday' }))).toBe('replay');
  });
});
