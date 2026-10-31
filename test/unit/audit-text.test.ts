// How the Audit view shows a stored value.
import { describe, expect, it } from 'vitest';
import { showingNul } from '../../src/shared/audit.js';

describe('showingNul', () => {
  it('draws every NUL as a symbol and leaves the rest alone', () => {
    expect(showingNul('order\u00007\u0000')).toBe('order␀7␀');
    expect(showingNul('orders.dlq')).toBe('orders.dlq');
  });
});
