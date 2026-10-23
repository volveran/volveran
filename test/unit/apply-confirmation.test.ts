// What the Apply confirmation asks for: a typed queue name only on a
// Protected Profile with a Decision other than Keep.
import { describe, expect, it } from 'vitest';
import { applyConfirmationFor, confirmationProblem } from '../../src/server/triage/apply-confirmation.js';

describe('Apply confirmation', () => {
  it('asks for the typed queue name only on a Protected Profile with a Decision other than Keep', () => {
    expect(applyConfirmationFor({ protectedProfile: true, actionCount: 1 })).toEqual({ typeQueueName: true });
    expect(applyConfirmationFor({ protectedProfile: true, actionCount: 0 })).toEqual({ typeQueueName: false });
    expect(applyConfirmationFor({ protectedProfile: false, actionCount: 3 })).toEqual({ typeQueueName: false });
  });

  it('accepts only the exact queue name', () => {
    const needed = { typeQueueName: true };
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
    expect(confirmationProblem({ typeQueueName: false }, 'q', { confirm: true })).toBeNull();
    expect(confirmationProblem({ typeQueueName: false }, 'q', {})).toBe('confirmation_required');
    expect(confirmationProblem({ typeQueueName: true }, 'q', { confirmQueueName: 'q' })).toBe('confirmation_required');
  });
});
