// Where Messages a Checkout returns end up in the queue, as the UI words it
// (docs/rabbitmq-behaviour.md "Order after a return").
import { describe, expect, it } from 'vitest';
import { returnOrder } from '../../src/shared/return-order.js';

describe('returnOrder', () => {
  it('promises the original positions on a classic queue', () => {
    expect(returnOrder('classic')).toBe('in their original positions');
  });

  it('on a quorum queue, puts them ahead of newer Messages but behind any returned earlier, and does not promise the order of a large Checkout', () => {
    expect(returnOrder('quorum')).toBe('ahead of newer Messages but behind any returned earlier, in their original order unless the Checkout was large');
  });
});
