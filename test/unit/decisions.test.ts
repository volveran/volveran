// Decisions: reading them from a request, which Messages can take them, the
// Apply plan and the summary shown before Apply.
import { describe, expect, it } from 'vitest';
import { summaryText, type Decision } from '../../src/shared/decisions.js';
import {
  buildApplyPlan,
  decisionNotAllowed,
  messageCannotTake,
  parseDecision,
  summarizeDecisions,
} from '../../src/server/triage/decisions.js';
import type { Delivery } from '../../src/server/triage/message-view.js';

const discard = { kind: 'discard', reason: 'poison message' } as const;
const keep = { kind: 'keep' } as const;
const replay = { kind: 'replay' } as const;
const moveTo = (queue: string) => ({ kind: 'move', destination: { queue } }) as const;

function delivery(headers?: Record<string, unknown>): Delivery {
  return {
    fields: { exchange: 'orders.dlx', routingKey: 'orders.created', redelivered: false },
    properties: { headers },
    content: Buffer.from('{}'),
  };
}

describe('buildApplyPlan', () => {
  it('turns every Decision other than Keep into a step, in Checkout order', () => {
    const plan = buildApplyPlan(
      [1, 2, 3, 4],
      new Map<number, Decision>([
        [3, discard],
        [1, replay],
        [2, keep],
      ]),
    );

    expect(plan).toEqual({
      steps: [
        { handle: 1, decision: replay },
        { handle: 3, decision: discard },
      ],
      kept: [2, 4],
    });
  });

  it('ignores Decisions for Messages the Checkout no longer holds', () => {
    expect(buildApplyPlan([1], new Map<number, Decision>([[9, discard]]))).toEqual({ steps: [], kept: [1] });
  });
});

describe('summarizeDecisions', () => {
  it('counts the Messages per Decision, Moves per destination, Keep last', () => {
    const decisions = new Map<number, Decision>([
      [1, discard],
      [2, moveTo('orders.manual')],
      [3, { kind: 'discard', reason: 'another reason' }],
      [4, replay],
      [5, moveTo('audit.hold')],
      [6, moveTo('orders.manual')],
      [7, { kind: 'move', destination: { exchange: 'orders', routingKey: 'orders.retry' } }],
      [8, keep],
    ]);

    expect(summarizeDecisions([1, 2, 3, 4, 5, 6, 7, 8, 9], decisions)).toEqual([
      { kind: 'discard', count: 2 },
      { kind: 'replay', count: 1 },
      { kind: 'move', destination: { queue: 'audit.hold' }, count: 1 },
      { kind: 'move', destination: { queue: 'orders.manual' }, count: 2 },
      { kind: 'move', destination: { exchange: 'orders', routingKey: 'orders.retry' }, count: 1 },
      { kind: 'keep', count: 2 },
    ]);
  });

  it('is only Keep when nothing has been decided', () => {
    expect(summarizeDecisions([1, 2], new Map())).toEqual([{ kind: 'keep', count: 2 }]);
  });

  it('is empty for an empty Checkout', () => {
    expect(summarizeDecisions([], new Map())).toEqual([]);
  });
});

describe('summaryText', () => {
  it('reads like the Apply confirmation', () => {
    expect(
      summaryText([
        { kind: 'discard', count: 12 },
        { kind: 'replay', count: 40 },
        { kind: 'move', destination: { queue: 'orders.manual' }, count: 3 },
        { kind: 'move', destination: { exchange: 'orders', routingKey: '' }, count: 1 },
        { kind: 'keep', count: 145 },
      ]),
    ).toBe(
      '12 Discard, 40 Replay, 3 Move to orders.manual, 1 Move to exchange orders with an empty routing key, 145 Keep',
    );
  });

  it('says so when there is nothing to Apply', () => {
    expect(summaryText([])).toBe('No Messages');
  });
});

describe('parseDecision', () => {
  it.each([
    [{ kind: 'keep' }, { kind: 'keep' }],
    [{ kind: 'discard', reason: '  poison message ' }, { kind: 'discard', reason: 'poison message' }],
    [{ kind: 'replay' }, { kind: 'replay' }],
    [{ kind: 'replay', destination: 'ignored' }, { kind: 'replay' }],
    [
      { kind: 'move', destination: { queue: 'orders.manual' } },
      { kind: 'move', destination: { queue: 'orders.manual' } },
    ],
    [
      { kind: 'move', destination: { exchange: 'orders', routingKey: 'orders.created' } },
      { kind: 'move', destination: { exchange: 'orders', routingKey: 'orders.created' } },
    ],
    [
      { kind: 'move', destination: { exchange: 'audit.fanout', routingKey: '' } },
      { kind: 'move', destination: { exchange: 'audit.fanout', routingKey: '' } },
    ],
  ])('accepts %j', (input, expected) => {
    expect(parseDecision(input)).toEqual({ ok: true, decision: expected });
  });

  it.each([
    [undefined, /kind/],
    ['keep', /kind/],
    [{ kind: 'selective-purge' }, /"selective-purge" is not a Decision; use one of keep, discard, replay, move/],
    [{ kind: 'discard' }, /Discard needs a "reason"/],
    [{ kind: 'discard', reason: '   ' }, /Discard needs a "reason"/],
    [{ kind: 'discard', reason: 7 }, /Discard needs a "reason"/],
    [{ kind: 'move' }, /destination/],
    [{ kind: 'move', destination: 'orders.manual' }, /destination/],
    [{ kind: 'move', destination: { queue: '' } }, /queue name/],
    [{ kind: 'move', destination: { exchange: 'orders' } }, /"routingKey"/],
    [{ kind: 'move', destination: { exchange: '', routingKey: 'orders.manual' } }, /default exchange/],
    [{ kind: 'move', destination: { queue: 'a', exchange: 'b', routingKey: 'c' } }, /either a queue or an exchange/],
  ])('rejects %j', (input, message) => {
    const result = parseDecision(input);
    expect(result.ok).toBe(false);
    expect(!result.ok && result.error).toMatch(message);
  });
});

describe('decisionNotAllowed', () => {
  it('refuses a Move to the queue being triaged', () => {
    expect(decisionNotAllowed(moveTo('orders.dlq'), 'orders.dlq')).toMatch(/already in "orders.dlq"/);
    expect(decisionNotAllowed(moveTo('orders.manual'), 'orders.dlq')).toBeNull();
  });

  it('allows every other Decision', () => {
    for (const d of [keep, discard, replay]) expect(decisionNotAllowed(d, 'orders.dlq')).toBeNull();
  });
});

describe('messageCannotTake', () => {
  const deadLettered = delivery({ 'x-death': [{ queue: 'orders.work', reason: 'rejected', count: 1 }] });

  it('refuses Replay for a Message with no x-death history, saying why', () => {
    expect(messageCannotTake(replay, delivery())).toMatch(/no x-death history/);
    expect(messageCannotTake(replay, delivery({ 'x-death': [] }))).toMatch(/no x-death history/);
    expect(messageCannotTake(replay, deadLettered)).toBeNull();
  });

  it('lets any Message take the other Decisions', () => {
    for (const d of [keep, discard, moveTo('orders.manual')]) expect(messageCannotTake(d, delivery())).toBeNull();
  });
});
