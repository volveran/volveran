// How many Messages a Checkout takes (the Message limit) and which
// deliveries it holds, overflows past the byte limit, or returns as late.
import { describe, expect, it } from 'vitest';
import { CheckoutCollection, checkoutSize, collectionWindow, parseCheckoutLimits } from '../../src/server/triage/checkout-collection.js';

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

describe('collectionWindow', () => {
  it('asks for one delivery first, before any body size is known', () => {
    expect(collectionWindow({ remaining: 1000, remainingBytes: 100 * MB, delivered: 0, deliveredBytes: 0 })).toBe(1);
  });

  it('asks for as many as the remaining bytes fit at the average body size so far', () => {
    // 4 of ~1 MB delivered, 6 MB left: 6 more.
    expect(collectionWindow({ remaining: 46, remainingBytes: 6 * MB, delivered: 4, deliveredBytes: 4 * MB })).toBe(4);
    expect(collectionWindow({ remaining: 46, remainingBytes: 6 * MB, delivered: 8, deliveredBytes: 8 * MB })).toBe(6);
  });

  it('at most doubles what was delivered, in case the first bodies were unusually small', () => {
    expect(collectionWindow({ remaining: 999, remainingBytes: 100 * MB, delivered: 1, deliveredBytes: 7 })).toBe(1);
    expect(collectionWindow({ remaining: 990, remainingBytes: 100 * MB, delivered: 10, deliveredBytes: 70 })).toBe(10);
  });

  it('never asks for more than the Messages still to take', () => {
    expect(collectionWindow({ remaining: 3, remainingBytes: 100 * MB, delivered: 10, deliveredBytes: 70 })).toBe(3);
  });

  it('asks for at least one, which tells whether the next body still fits', () => {
    expect(collectionWindow({ remaining: 40, remainingBytes: 0, delivered: 10, deliveredBytes: 10 * MB })).toBe(1);
    expect(collectionWindow({ remaining: 40, remainingBytes: 10, delivered: 2, deliveredBytes: 0 })).toBe(2);
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

  it('asks for the next window from what it holds so far, and for nothing once done', () => {
    const c = new CheckoutCollection<string>(50, 5 * MB);
    expect(c.nextWindow()).toBe(1);
    c.offer('m1', MB);
    expect(c.nextWindow()).toBe(1);
    c.offer('m2', MB);
    expect(c.nextWindow()).toBe(2);
    c.offer('m3', MB);
    c.offer('m4', MB);
    // 1 MB left at 1 MB each.
    expect(c.nextWindow()).toBe(1);
    c.offer('m5', MB);
    expect(c.done).toBe(false);
    expect(c.nextWindow()).toBe(1);

    expect(c.offer('m6', MB)).toBe('overflow');

    expect(c.done).toBe(true);
    expect(c.nextWindow()).toBe(0);
  });

  it('keeps deliveries already on their way after the byte limit as overflow, in order', () => {
    const c = new CheckoutCollection<string>(50, 10);
    c.offer('a', 8);
    c.offer('b', 8);

    expect(c.offer('c', 1)).toBe('overflow');
    expect(c.overflow).toEqual(['b', 'c']);
  });

  it('is done once it has all N', () => {
    const c = new CheckoutCollection<string>(1, 10);
    c.offer('a', 1);
    expect(c.done).toBe(true);
    expect(c.nextWindow()).toBe(0);
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
