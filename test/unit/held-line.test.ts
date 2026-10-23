// The "N of ~M held" line of a Checkout, naming the limit that applied.
import { describe, expect, it } from 'vitest';
import { heldLine } from '../../src/shared/held-line.js';

const limits = { maxMessages: 1000, maxBytes: 100 * 1024 * 1024 };

describe('heldLine', () => {
  it('shows "1,000 of ~N held" when the Message limit applied', () => {
    expect(heldLine({ heldCount: 1000, readyAtStart: 4500, limitedBy: 'messages', limits })).toBe(
      '1,000 of ~4,500 held (limit 1,000 Messages)',
    );
  });

  it('names the byte limit when that applied', () => {
    expect(heldLine({ heldCount: 80, readyAtStart: 500, limitedBy: 'bytes', limits })).toBe(
      '80 of ~500 held (limit 100 MB)',
    );
  });

  it('shows the plain count when every ready Message is held', () => {
    expect(heldLine({ heldCount: 3, readyAtStart: 3, limitedBy: null, limits })).toBe('3 of ~3 held');
  });
});
