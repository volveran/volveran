// Where a Replay sends a Message (ADR 0005, amended by ADR 0010): the queue
// of its most recent x-death entry, else the MassTransit input queue of a
// Message MassTransit did not skip, or why it cannot be Replayed.
import { describe, expect, it } from 'vitest';
import { replayOrigin } from '../../src/server/triage/replay-origin.js';

describe('replayOrigin', () => {
  it('is the queue of the most recent x-death entry', () => {
    const headers = {
      'x-death': [
        { reason: 'expired', queue: 'orders.retry' },
        { reason: 'rejected', queue: 'orders.work' },
      ],
    };
    expect(replayOrigin(headers)).toEqual({ ok: true, queue: 'orders.retry', via: 'x-death' });
  });

  it('reads a queue name decoded as bytes', () => {
    expect(replayOrigin({ 'x-death': [{ queue: Buffer.from('payments.work') }] })).toEqual({
      ok: true,
      queue: 'payments.work',
      via: 'x-death',
    });
  });

  it('is unavailable, with the reason, without x-death history', () => {
    for (const headers of [undefined, {}, { 'x-death': [] }, { 'x-death': 'forged' }]) {
      expect(replayOrigin(headers)).toEqual({ ok: false, reason: expect.stringMatching(/no x-death history/) });
    }
  });

  it('is unavailable when the most recent entry names no queue', () => {
    expect(replayOrigin({ 'x-death': [{ reason: 'rejected' }, { queue: 'orders.work' }] })).toEqual({
      ok: false,
      reason: expect.stringMatching(/names no queue/),
    });
  });
});

describe('replayOrigin from framework headers', () => {
  const massTransit = {
    'MT-Reason': 'fault',
    'MT-Fault-ExceptionType': 'System.TimeoutException',
    'MT-Fault-InputAddress': 'rabbitmq://localhost/submit-order?temporary=false',
  };
  const spring = {
    'x-exception-message': 'Listener method threw exception',
    'x-original-exchange': 'orders',
    'x-original-routingKey': 'orders.created',
  };

  it('is the MassTransit input queue without x-death', () => {
    expect(replayOrigin(massTransit)).toEqual({ ok: true, queue: 'submit-order', via: 'masstransit' });
  });

  it('prefers the most recent x-death entry over the MassTransit input queue', () => {
    expect(replayOrigin({ ...massTransit, 'x-death': [{ queue: 'orders.work' }] })).toEqual({
      ok: true,
      queue: 'orders.work',
      via: 'x-death',
    });
  });

  it('is unavailable for a skipped MassTransit Message', () => {
    expect(replayOrigin({ ...massTransit, 'MT-Reason': 'skip' })).toEqual({
      ok: false,
      reason: expect.stringContaining('no consumer handled this Message type'),
    });
  });

  it('is unavailable when the MassTransit input address is missing or names no queue', () => {
    for (const headers of [{ 'MT-Reason': 'fault' }, { ...massTransit, 'MT-Fault-InputAddress': 'rabbitmq://localhost/' }]) {
      expect(replayOrigin(headers)).toEqual({ ok: false, reason: expect.stringMatching(/input address/) });
    }
  });

  it('is unavailable for a Spring AMQP Message, naming its original exchange and routing key and suggesting that Move', () => {
    expect(replayOrigin(spring)).toEqual({
      ok: false,
      reason: expect.stringContaining('exchange "orders" with the routing key "orders.created"'),
      suggestedMove: { exchange: 'orders', routingKey: 'orders.created' },
    });
  });

  it('suggests a Move to the queue a Spring AMQP Message was first sent to through the default exchange', () => {
    expect(replayOrigin({ ...spring, 'x-original-exchange': '', 'x-original-routingKey': 'orders.work' })).toEqual({
      ok: false,
      reason: expect.stringContaining('default exchange with the routing key "orders.work"'),
      suggestedMove: { queue: 'orders.work' },
    });
  });

  it('suggests no Move for a Spring AMQP Message without its original exchange', () => {
    expect(replayOrigin({ 'x-exception-message': 'boom' })).toEqual({ ok: false, reason: expect.stringMatching(/Spring AMQP/) });
  });

  it('still Replays a Spring AMQP Message that has x-death history', () => {
    expect(replayOrigin({ ...spring, 'x-death': [{ queue: 'orders.work' }] })).toEqual({ ok: true, queue: 'orders.work', via: 'x-death' });
  });
});
