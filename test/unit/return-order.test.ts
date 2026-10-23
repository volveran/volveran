// Where Messages a Checkout returns end up in the queue, as the UI words it
// (docs/rabbitmq-behaviour.md "Order after a return").
import { describe, expect, it } from 'vitest';
import { returnOrder } from '../../src/shared/return-order.js';

describe('returnOrder', () => {
  it('promises the original positions on a classic queue', () => {
    expect(returnOrder('classic')).toBe('in their original positions');
  });

  it('on a quorum queue, puts them ahead of newer Messages but behind any returned earlier', () => {
    expect(returnOrder('quorum')).toBe('in their original order, ahead of newer Messages but behind any returned earlier');
  });
});
