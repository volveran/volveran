// Failure Details read from the headers Spring AMQP (RepublishMessageRecoverer)
// and MassTransit write when they give up on a Message.
import { describe, expect, it } from 'vitest';
import { failureDetails } from '../../src/server/triage/failure-details.js';

describe('Spring AMQP headers', () => {
  it('reads the exception message, stack trace and original exchange and routing key', () => {
    expect(
      failureDetails({
        'x-exception-message': 'Listener threw exception',
        'x-exception-stacktrace': 'org.springframework.amqp.AmqpRejectAndDontRequeueException: boom\n\tat com.acme.Orders.handle(Orders.java:42)',
        'x-original-exchange': 'orders',
        'x-original-routingKey': 'orders.created',
      }),
    ).toEqual({
      framework: 'spring',
      exceptionType: null,
      message: 'Listener threw exception',
      stackTrace: 'org.springframework.amqp.AmqpRejectAndDontRequeueException: boom\n\tat com.acme.Orders.handle(Orders.java:42)',
      consumerType: null,
      messageType: null,
      faultAt: null,
      retryCount: null,
      redeliveryCount: null,
      host: null,
      reason: null,
      originalExchange: 'orders',
      originalRoutingKey: 'orders.created',
      inputQueue: null,
      extra: {},
    });
  });

  it('keeps any other x-exception-* header as an extra field', () => {
    const details = failureDetails({
      'x-exception-message': 'boom',
      'x-exception-fqcn': 'java.lang.IllegalStateException',
      'x-exception-cause-fqcn': 'java.io.IOException',
      'x-original-exchange': '',
    });
    expect(details?.extra).toEqual({
      'x-exception-fqcn': 'java.lang.IllegalStateException',
      'x-exception-cause-fqcn': 'java.io.IOException',
    });
    expect(details?.originalExchange).toBe('');
  });

  it('decodes byte-array values', () => {
    const details = failureDetails({
      'x-exception-message': Buffer.from('café broke'),
      'x-exception-stacktrace': Buffer.from('trace'),
      'x-original-routingKey': Buffer.from('orders.created'),
    });
    expect(details).toMatchObject({ message: 'café broke', stackTrace: 'trace', originalRoutingKey: 'orders.created' });
  });

  it('reads only the capital-K routing key header Spring writes', () => {
    expect(failureDetails({ 'x-exception-message': 'boom', 'x-original-routingkey': 'orders' })?.originalRoutingKey).toBeNull();
  });
});

const masstransit = {
  'MT-Reason': 'fault',
  'MT-Fault-ExceptionType': 'System.InvalidOperationException',
  'MT-Fault-Message': 'Order 42 has no lines',
  'MT-Fault-StackTrace': '   at Acme.Orders.SubmitOrderConsumer.Consume(ConsumeContext`1 context)',
  'MT-Fault-ConsumerType': 'Acme.Orders.SubmitOrderConsumer',
  'MT-Fault-MessageType': 'Acme.Contracts.SubmitOrder',
  'MT-Fault-Timestamp': '2026-10-28T17:46:00.1234567Z',
  'MT-Fault-RetryCount': 3,
  'MT-Fault-RedeliveryCount': 1,
  'MT-Fault-InputAddress': 'rabbitmq://broker.acme.internal/prod/submit-order',
  'MT-Fault-Address': 'rabbitmq://broker.acme.internal/prod/submit-order_error',
  'MT-Host-MachineName': 'orders-7d9f',
  'MT-Host-ProcessName': 'Acme.Orders',
  'MT-Host-ProcessId': 17,
  'MT-Host-MassTransitVersion': '8.3.0.0',
};

describe('MassTransit headers', () => {
  it('reads every fault and host header', () => {
    expect(failureDetails(masstransit)).toEqual({
      framework: 'masstransit',
      exceptionType: 'System.InvalidOperationException',
      message: 'Order 42 has no lines',
      stackTrace: '   at Acme.Orders.SubmitOrderConsumer.Consume(ConsumeContext`1 context)',
      consumerType: 'Acme.Orders.SubmitOrderConsumer',
      messageType: 'Acme.Contracts.SubmitOrder',
      faultAt: '2026-10-28T17:46:00.123Z',
      retryCount: 3,
      redeliveryCount: 1,
      host: { MachineName: 'orders-7d9f', ProcessName: 'Acme.Orders', ProcessId: '17', MassTransitVersion: '8.3.0.0' },
      reason: 'fault',
      originalExchange: null,
      originalRoutingKey: null,
      inputQueue: 'submit-order',
      extra: {
        'MT-Fault-InputAddress': 'rabbitmq://broker.acme.internal/prod/submit-order',
        'MT-Fault-Address': 'rabbitmq://broker.acme.internal/prod/submit-order_error',
      },
    });
  });

  it('decodes byte arrays and reads counts written as text', () => {
    expect(
      failureDetails({
        'MT-Fault-ExceptionType': Buffer.from('System.TimeoutException'),
        'MT-Fault-Message': Buffer.from('The operation timed out'),
        'MT-Fault-RetryCount': '5',
        'MT-Fault-RedeliveryCount': 2n,
        'MT-Fault-InputAddress': Buffer.from('rabbitmq://localhost/payments'),
        'MT-Host-MachineName': Buffer.from('pay-1'),
      }),
    ).toMatchObject({
      exceptionType: 'System.TimeoutException',
      message: 'The operation timed out',
      retryCount: 5,
      redeliveryCount: 2,
      inputQueue: 'payments',
      host: { MachineName: 'pay-1' },
    });
  });

  it('takes the input queue from the last path segment, without the query string, URL-decoded', () => {
    const queue = (address: string) => failureDetails({ 'MT-Fault-InputAddress': address })?.inputQueue;
    expect(queue('rabbitmq://localhost/submit-order')).toBe('submit-order');
    expect(queue('rabbitmq://localhost/prod/submit-order')).toBe('submit-order');
    expect(queue('rabbitmq://localhost:5672/prod/submit-order?bind=true&durable=false')).toBe('submit-order');
    expect(queue('rabbitmq://localhost/%2F/orders%20eu%3Asubmit')).toBe('orders eu:submit');
    expect(queue('rabbitmq://localhost/')).toBeNull();
    expect(queue('rabbitmq://localhost')).toBeNull();
    expect(queue('rabbitmq://localhost/prod/bad%E0name')).toBe('bad%E0name');
  });

  it('tells a skipped Message apart from a fault', () => {
    expect(failureDetails({ 'MT-Reason': 'skip', 'MT-Fault-InputAddress': 'rabbitmq://localhost/orders' })).toMatchObject({
      framework: 'masstransit',
      reason: 'skip',
      exceptionType: null,
      message: null,
      inputQueue: 'orders',
    });
    expect(failureDetails({ 'MT-Reason': 'something-else' })?.reason).toBeNull();
  });

  it('leaves missing fields null and an unreadable fault time as written', () => {
    expect(failureDetails({ 'MT-Fault-Message': 'boom', 'MT-Fault-Timestamp': 'yesterday', 'MT-Fault-RetryCount': 'many' })).toMatchObject({
      exceptionType: null,
      stackTrace: null,
      consumerType: null,
      messageType: null,
      faultAt: 'yesterday',
      retryCount: null,
      redeliveryCount: null,
      host: null,
      inputQueue: null,
      extra: {},
    });
  });

  it('reads a fault time sent as an AMQP timestamp', () => {
    expect(failureDetails({ 'MT-Fault-Message': 'boom', 'MT-Fault-Timestamp': { '!': 'timestamp', value: 1793295960 } })?.faultAt).toBe(
      new Date(1793295960 * 1000).toISOString(),
    );
  });
});

describe('Messages without Failure Details', () => {
  it('is null when no framework header is present', () => {
    expect(failureDetails(undefined)).toBeNull();
    expect(failureDetails({})).toBeNull();
    expect(failureDetails({ 'x-death': [], 'x-original-exchange': 'orders', tenant: 'acme' })).toBeNull();
  });
});
