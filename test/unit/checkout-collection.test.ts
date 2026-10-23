// How many Messages a Checkout takes (the Message limit) and which
// deliveries it holds, overflows past the byte limit, or returns as late.
import { describe, expect, it } from 'vitest';
import { CheckoutCollection, checkoutSize, parseCheckoutLimits } from '../../src/server/triage/checkout-collection.js';

const MB = 1024 * 1024;

describe('checkoutSize', () => {
  it('takes every ready Message when the queue is within the Message limit', () => {
    expect(checkoutSize({ ready: 3, maxMessages: 1000 })).toEqual({ take: 3, limitedBy: null });
  });

  it('takes at most the Message limit', () => {
    expect(checkoutSize({ ready: 4500, maxMessages: 1000 })).toEqual({ take: 1000, limitedBy: 'messages' });
  });

  it('takes nothing from an empty queue', () => {
    expect(checkoutSize({ ready: 0, maxMessages: 1000 })).toEqual({ take: 0, limitedBy: null });
  });
});

describe('CheckoutCollection', () => {
  it('holds the first N deliveries and is complete once it has them', () => {
    const c = new CheckoutCollection<string>(2, 100);

    expect(c.offer('a', 1)).toBe('held');
    expect(c.complete).toBe(false);
    expect(c.offer('b', 1)).toBe('held');

    expect(c.complete).toBe(true);
    expect(c.held).toEqual(['a', 'b']);
    expect(c.heldBytes).toBe(2);
  });

  it('returns a delivery beyond the N the queue had when the Checkout started', () => {
    const c = new CheckoutCollection<string>(1, 100);
    c.offer('a', 1);

    expect(c.offer('late', 1)).toBe('late');
    expect(c.late).toEqual(['late']);
    expect(c.held).toEqual(['a']);
  });

  it('returns every delivery that arrives after it stopped waiting for fewer than N', () => {
    const c = new CheckoutCollection<string>(3, 100);
    c.offer('a', 1);

    c.close();

    expect(c.offer('arrived-after-start', 1)).toBe('late');
    expect(c.held).toEqual(['a']);
    expect(c.late).toEqual(['arrived-after-start']);
  });

  it('stops holding at the byte limit; the rest of the N overflow, to go back after the held ones', () => {
    const c = new CheckoutCollection<string>(4, 10);

    expect(c.offer('a', 6)).toBe('held');
    expect(c.offer('b', 6)).toBe('overflow');
    // Held Messages stay a prefix of the queue: a smaller one after the limit overflows too.
    expect(c.offer('c', 1)).toBe('overflow');
    expect(c.complete).toBe(false);
    expect(c.offer('d', 1)).toBe('overflow');

    expect(c.complete).toBe(true);
    expect(c.held).toEqual(['a']);
    expect(c.overflow).toEqual(['b', 'c', 'd']);
    expect(c.offer('e', 1)).toBe('late');
  });

  it('holds a first Message larger than the byte limit', () => {
    const c = new CheckoutCollection<string>(2, 10);
    expect(c.offer('huge', 50)).toBe('held');
    expect(c.offer('next', 1)).toBe('overflow');
  });
});

describe('parseCheckoutLimits', () => {
  it('defaults to 1,000 Messages and 100 MB', () => {
    expect(parseCheckoutLimits({})).toEqual({ ok: true, limits: { maxMessages: 1000, maxBytes: 100 * MB } });
  });

  it('reads VOLVERAN_CHECKOUT_MAX_MESSAGES and VOLVERAN_CHECKOUT_MAX_MB', () => {
    expect(parseCheckoutLimits({ VOLVERAN_CHECKOUT_MAX_MESSAGES: '50', VOLVERAN_CHECKOUT_MAX_MB: '2' })).toEqual({
      ok: true,
      limits: { maxMessages: 50, maxBytes: 2 * MB },
    });
  });

  it('refuses values that are not positive whole numbers, or more Messages than a prefetch can take', () => {
    for (const env of [
      { VOLVERAN_CHECKOUT_MAX_MESSAGES: '0' },
      { VOLVERAN_CHECKOUT_MAX_MESSAGES: 'lots' },
      { VOLVERAN_CHECKOUT_MAX_MESSAGES: '70000' },
      { VOLVERAN_CHECKOUT_MAX_MB: '-1' },
      { VOLVERAN_CHECKOUT_MAX_MB: '1.5' },
    ]) {
      expect(parseCheckoutLimits(env)).toEqual({ ok: false, error: expect.stringContaining(Object.keys(env)[0]!) });
    }
  });
});
