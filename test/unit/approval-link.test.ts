// The link to a waiting Checkout that a requester pastes in chat: it opens
// the Approvals view on that Checkout, and survives sign-in (returnTo keeps
// the fragment).
import { describe, expect, it } from 'vitest';
import { approvalLink, waitingCheckoutIn } from '../../src/shared/approval-link.js';

describe('approvalLink', () => {
  it('points at the waiting Checkout under Approvals, on the app the requester uses', () => {
    expect(approvalLink('https://volveran.example.com', '6f1c2a9e-1b2c-4d5e-8f90-0a1b2c3d4e5f')).toBe(
      'https://volveran.example.com/#/approvals/6f1c2a9e-1b2c-4d5e-8f90-0a1b2c3d4e5f',
    );
  });

  it('is read back from the fragment', () => {
    expect(waitingCheckoutIn('#/approvals/6f1c2a9e-1b2c-4d5e-8f90-0a1b2c3d4e5f')).toBe(
      '6f1c2a9e-1b2c-4d5e-8f90-0a1b2c3d4e5f',
    );
  });

  it('keeps an odd id intact both ways', () => {
    const link = approvalLink('http://127.0.0.1:3000', 'a/b c');
    expect(waitingCheckoutIn(new URL(link).hash)).toBe('a/b c');
  });

  it('finds no waiting Checkout in any other fragment', () => {
    for (const hash of ['', '#', '#/approvals/', '#/audit', '#/approvals']) expect(waitingCheckoutIn(hash)).toBeNull();
  });
});
