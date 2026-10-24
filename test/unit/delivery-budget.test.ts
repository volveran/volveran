// Delivery Budget on quorum queues (delivery_limit minus x-delivery-count)
// and the warning for Messages with 1 left.
import { describe, expect, it } from 'vitest';
import { deliveryBudget } from '../../src/server/triage/delivery-budget.js';

describe('deliveryBudget', () => {
  it("is the queue's delivery_limit minus the Message's x-delivery-count", () => {
    expect(deliveryBudget({ deliveryCount: 2, deliveryLimit: 5, deadLetterExchange: false })).toEqual({
      remaining: 3,
      warning: null,
    });
  });

  it('warns about a Message with 1 left that a Lost Checkout would drop (no dead-letter exchange)', () => {
    expect(deliveryBudget({ deliveryCount: 4, deliveryLimit: 5, deadLetterExchange: false })).toEqual({
      remaining: 1,
      warning: 'Delivery Budget 1: if this Checkout is lost, the broker drops this Message.',
    });
  });

  it('warns about a Message with 1 left that a Lost Checkout would dead-letter again', () => {
    expect(deliveryBudget({ deliveryCount: 19, deliveryLimit: 20, deadLetterExchange: true })?.warning).toBe(
      'Delivery Budget 1: if this Checkout is lost, the broker dead-letters this Message again.',
    );
  });

  it('warns at 0 or below too, never showing a negative budget', () => {
    expect(deliveryBudget({ deliveryCount: 7, deliveryLimit: 5, deadLetterExchange: false })).toEqual({
      remaining: 0,
      warning: 'Delivery Budget 0: if this Checkout is lost, the broker drops this Message.',
    });
  });

  it('a fresh Message on a queue with delivery-limit 1 has 1 left', () => {
    expect(deliveryBudget({ deliveryCount: 0, deliveryLimit: 1, deadLetterExchange: false })?.remaining).toBe(1);
  });

  it('has no Delivery Budget on classic queues (no count) or without a limit (null or negative)', () => {
    expect(deliveryBudget({ deliveryCount: null, deliveryLimit: 5, deadLetterExchange: false })).toBeNull();
    expect(deliveryBudget({ deliveryCount: 40, deliveryLimit: null, deadLetterExchange: false })).toBeNull();
    expect(deliveryBudget({ deliveryCount: 40, deliveryLimit: -1, deadLetterExchange: false })).toBeNull();
  });
});
