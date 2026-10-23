import { describe, expect, it } from 'vitest';
import {
  checkoutHolders,
  holderFromLockArguments,
  isLockQueue,
  lockArguments,
  lockQueueName,
} from '../../src/server/triage/checkout-lock.js';

describe('lockQueueName', () => {
  it('is volveran.checkout.<queue>', () => {
    expect(lockQueueName('orders.dlq')).toBe('volveran.checkout.orders.dlq');
  });

  it('stays within the 255-byte queue name limit for long queue names, distinct per queue', () => {
    const a = lockQueueName('é'.repeat(200) + 'a');
    const b = lockQueueName('é'.repeat(200) + 'b');
    expect(Buffer.byteLength(a)).toBeLessThanOrEqual(255);
    expect(a.startsWith('volveran.checkout.')).toBe(true);
    expect(a).not.toBe(b);
  });
});

describe('lock arguments', () => {
  it('carry the holder (Operator, start time), its Operator.id and the queue, and read back', () => {
    const args = lockArguments('orders.dlq', { operator: 'alice', since: '2026-10-23T10:00:00.000Z' }, 'alice-sub');
    expect(args['volveran-operator-id']).toBe('alice-sub');
    expect(holderFromLockArguments({ ...args, 'x-queue-type': 'classic' })).toEqual({
      queue: 'orders.dlq',
      holder: { operator: 'alice', since: '2026-10-23T10:00:00.000Z' },
      operatorId: 'alice-sub',
    });
  });

  it('read back a lock without an Operator.id', () => {
    const { 'volveran-operator-id': _id, ...args } = lockArguments('q', { operator: 'alice', since: 's' }, 'alice-sub');
    expect(holderFromLockArguments(args)?.operatorId).toBeNull();
  });

  it('are not a Checkout lock without them', () => {
    expect(holderFromLockArguments({})).toBeNull();
    expect(holderFromLockArguments({ 'volveran-queue': 'q', 'volveran-operator': 3 })).toBeNull();
  });
});

describe('checkoutHolders', () => {
  it('maps each checked-out queue to its holder, from the lock queues in a queue list', () => {
    const lock = {
      name: lockQueueName('orders.dlq'),
      arguments: lockArguments('orders.dlq', { operator: 'bob', since: '2026-10-23T10:00:00.000Z' }, 'bob-sub'),
    };
    const holders = checkoutHolders([{ name: 'orders.dlq', arguments: {} }, lock]);
    expect([...holders]).toEqual([['orders.dlq', { operator: 'bob', since: '2026-10-23T10:00:00.000Z' }]]);
  });

  it('recognises lock queues by name', () => {
    expect(isLockQueue('volveran.checkout.orders.dlq')).toBe(true);
    expect(isLockQueue('orders.dlq')).toBe(false);
  });
});
