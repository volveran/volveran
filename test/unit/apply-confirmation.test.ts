// What the Apply confirmation asks for: a typed queue name only on a
// Protected Profile with a Decision other than Keep.
import { describe, expect, it } from 'vitest';
import { applyConfirmationFor, confirmationProblem } from '../../src/server/triage/apply-confirmation.js';

describe('Apply confirmation', () => {
  it('asks for the typed queue name only on a Protected Profile with a Decision other than Keep', () => {
    const typed = (protectedProfile: boolean, actionCount: number) =>
      applyConfirmationFor({ protectedProfile, requireApproval: false, actionCount }).typeQueueName;
    expect(typed(true, 1)).toBe(true);
    expect(typed(true, 0)).toBe(false);
    expect(typed(false, 3)).toBe(false);
  });

  it('asks for Approval only when the Protected Profile requires it and a Decision is not Keep', () => {
    expect(applyConfirmationFor({ protectedProfile: true, requireApproval: true, actionCount: 1 })).toEqual({
      typeQueueName: true,
      approvalRequired: true,
    });
    expect(applyConfirmationFor({ protectedProfile: true, requireApproval: true, actionCount: 0 }).approvalRequired).toBe(false);
    expect(applyConfirmationFor({ protectedProfile: true, requireApproval: false, actionCount: 2 }).approvalRequired).toBe(false);
    expect(applyConfirmationFor({ protectedProfile: false, requireApproval: true, actionCount: 2 }).approvalRequired).toBe(false);
  });

  it('accepts only the exact queue name', () => {
    const needed = { typeQueueName: true, approvalRequired: false };
    expect(confirmationProblem(needed, 'orders.dlq', { confirm: true, confirmQueueName: 'orders.dlq' })).toBeNull();
    expect(confirmationProblem(needed, 'orders.dlq', { confirm: true, confirmQueueName: 'Orders.dlq' })).toBe(
      'queue_name_confirmation_required',
    );
    expect(confirmationProblem(needed, 'orders.dlq', { confirm: true, confirmQueueName: ' orders.dlq' })).toBe(
      'queue_name_confirmation_required',
    );
    expect(confirmationProblem(needed, 'orders.dlq', { confirm: true })).toBe('queue_name_confirmation_required');
  });

  it('always needs the single confirmation', () => {
    expect(confirmationProblem({ typeQueueName: false, approvalRequired: false }, 'q', { confirm: true })).toBeNull();
    expect(confirmationProblem({ typeQueueName: false, approvalRequired: false }, 'q', {})).toBe('confirmation_required');
    expect(confirmationProblem({ typeQueueName: true, approvalRequired: false }, 'q', { confirmQueueName: 'q' })).toBe('confirmation_required');
  });
});
