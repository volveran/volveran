// The republish rules (ADR 0005) shared by Replay, Move and Restore.
import { describe, expect, it } from 'vitest';
import { cleanHeaders, republishOptions } from '../../src/server/apply/republish.js';

const provenance = { replayId: 'r-1', from: 'orders.dlq' };

describe('cleanHeaders', () => {
  it('removes the routing and dead-letter headers and adds the replay id and source queue', () => {
    const headers = {
      CC: ['orders.audit'],
      BCC: ['orders.shadow'],
      'x-death': [{ queue: 'orders.work', reason: 'rejected', count: 1 }],
      'x-first-death-queue': 'orders.work',
      'x-first-death-reason': 'rejected',
      'x-first-death-exchange': 'orders',
      'x-last-death-queue': 'orders.work',
      'x-last-death-reason': 'rejected',
      'x-last-death-exchange': 'orders',
      'x-delivery-count': 3,
      'x-acquired-count': 4,
      tenant: 'acme',
      'x-trace': 'abc',
    };
    expect(cleanHeaders(headers, provenance)).toEqual({
      tenant: 'acme',
      'x-trace': 'abc',
      'x-volveran-replay-id': 'r-1',
      'x-volveran-from': 'orders.dlq',
    });
  });

  it('removes the Failure Details headers Spring AMQP and MassTransit wrote', () => {
    const headers = {
      'x-exception-message': 'Listener method threw exception',
      'x-exception-stacktrace': 'at OrderListener.onOrder',
      'x-exception-cause-fqcn': 'java.lang.IllegalStateException',
      'x-original-exchange': 'orders',
      'x-original-routingKey': 'orders.created',
      'MT-Reason': 'fault',
      'MT-Fault-ExceptionType': 'System.TimeoutException',
      'MT-Fault-InputAddress': 'rabbitmq://localhost/submit-order',
      'MT-Host-MachineName': 'orders-7d9f',
      'MT-MessageType': 'urn:message:Acme.Contracts:SubmitOrder',
      'x-original-queue': 'kept',
      tenant: 'acme',
    };
    expect(cleanHeaders(headers, provenance)).toEqual({
      'MT-MessageType': 'urn:message:Acme.Contracts:SubmitOrder',
      'x-original-queue': 'kept',
      tenant: 'acme',
      'x-volveran-replay-id': 'r-1',
      'x-volveran-from': 'orders.dlq',
    });
  });

  it('adds only the provenance headers to a Message without headers', () => {
    expect(cleanHeaders(undefined, provenance)).toEqual({ 'x-volveran-replay-id': 'r-1', 'x-volveran-from': 'orders.dlq' });
  });

  it('replaces the provenance of an earlier Replay', () => {
    const headers = { 'x-volveran-replay-id': 'old', 'x-volveran-from': 'other.dlq' };
    expect(cleanHeaders(headers, provenance)).toEqual({ 'x-volveran-replay-id': 'r-1', 'x-volveran-from': 'orders.dlq' });
  });

  it('keeps headers that only resemble the removed ones', () => {
    const headers = { cc: 'lower', 'x-deaths': 1, 'x-death-note': 'n', 'my-x-delivery-count': 2 };
    expect(cleanHeaders(headers, provenance)).toEqual({ ...headers, ...{ 'x-volveran-replay-id': 'r-1', 'x-volveran-from': 'orders.dlq' } });
  });

  it('does not change the headers it is given', () => {
    const headers = { CC: ['a'], keep: 1 };
    cleanHeaders(headers, provenance);
    expect(headers).toEqual({ CC: ['a'], keep: 1 });
  });
});

describe('republishOptions', () => {
  it('reproduces every property, with cleaned headers', () => {
    const properties = {
      contentType: 'application/json',
      contentEncoding: 'gzip',
      deliveryMode: 2,
      priority: 5,
      correlationId: 'c-1',
      replyTo: 'replies',
      expiration: '60000',
      messageId: 'm-1',
      timestamp: 1700000000,
      type: 'order.created',
      userId: 'volveran-admin',
      appId: 'shop',
      clusterId: 'deprecated',
      headers: { CC: ['x'], 'x-death': [], tenant: 'acme' },
    };
    expect(republishOptions(properties, provenance)).toEqual({
      contentType: 'application/json',
      contentEncoding: 'gzip',
      deliveryMode: 2,
      priority: 5,
      correlationId: 'c-1',
      replyTo: 'replies',
      expiration: '60000',
      messageId: 'm-1',
      timestamp: 1700000000,
      type: 'order.created',
      userId: 'volveran-admin',
      appId: 'shop',
      headers: { tenant: 'acme', 'x-volveran-replay-id': 'r-1', 'x-volveran-from': 'orders.dlq' },
    });
  });

  it('leaves out properties the Message does not have', () => {
    expect(republishOptions({ messageId: undefined, priority: null, headers: undefined }, provenance)).toEqual({
      headers: { 'x-volveran-replay-id': 'r-1', 'x-volveran-from': 'orders.dlq' },
    });
  });
});
