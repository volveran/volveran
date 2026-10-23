// The typed queue name a Protected Profile requires for Apply and Restore.
import { describe, expect, it } from 'vitest';
import { requireTypedQueueName, TypedConfirmationError } from '../../src/server/protected-profile.js';

describe('requireTypedQueueName', () => {
  const prod = { name: 'prod', protected: true };

  it('accepts only the queue name typed exactly on a Protected Profile', () => {
    expect(() => requireTypedQueueName(prod, 'orders.dlq', { confirmQueueName: 'orders.dlq' }, 'Restore')).not.toThrow();
    for (const body of [undefined, {}, { confirmQueueName: 'Orders.dlq' }, { confirmQueueName: 'orders.dlq ' }]) {
      expect(() => requireTypedQueueName(prod, 'orders.dlq', body, 'Restore')).toThrow(TypedConfirmationError);
    }
  });

  it('names the profile, the action and the queue in the error', () => {
    try {
      requireTypedQueueName(prod, 'orders.dlq', {}, 'Restore');
      expect.unreachable();
    } catch (err) {
      expect(err).toMatchObject({ status: 400, code: 'queue_name_confirmation_required' });
      expect((err as Error).message).toMatch(/prod is a Protected Profile: Restore .*"orders\.dlq"/);
    }
  });

  it('asks for nothing on a profile that is not protected', () => {
    expect(() => requireTypedQueueName({ name: 'dev', protected: false }, 'orders.dlq', {}, 'Restore')).not.toThrow();
  });
});
