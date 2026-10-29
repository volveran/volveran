// Failure Details through the HTTP API: Messages published with the headers
// Spring AMQP's RepublishMessageRecoverer and MassTransit write (no broker
// dead-lettering, so no x-death) show the framework's exception as the
// dead-letter reason, its input queue as the original queue, and the full
// details in the Message view and the export. MassTransit's `_error` queues
// are listed as dead-letter queues, and the `failure` filter selects by
// exception text. x-death wins when a Message carries both.
import type * as amqp from 'amqplib';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { deadLetter, deadLetterRoutes, fixtureQueues, purgeQueues, startApp, testProfile, withChannel, type TestApp } from './harness.js';

const errorQueue = 'submit-order_error';
const skippedQueue = 'submit-order_skipped';
const checkoutPath = (queue: string) => `/api/profiles/local/vhosts/%2F/queues/${encodeURIComponent(queue)}/checkouts`;

/** As RepublishMessageRecoverer writes them (spring-amqp). */
const springHeaders = {
  'x-exception-message': 'Listener method threw exception',
  'x-exception-stacktrace':
    'org.springframework.amqp.rabbit.support.ListenerExecutionFailedException: Listener method threw exception\n\tat com.acme.orders.OrderListener.onOrder(OrderListener.java:42)',
  'x-original-exchange': 'orders',
  'x-original-routingKey': 'orders.created',
};

/** As MassTransit's RabbitMQ transport writes them when it moves a Message to `<queue>_error`. */
const massTransitHeaders = {
  'MT-Reason': 'fault',
  'MT-Fault-ExceptionType': 'System.TimeoutException',
  'MT-Fault-Message': 'The payment API timed out',
  'MT-Fault-StackTrace': '   at Acme.Orders.SubmitOrderConsumer.Consume(ConsumeContext`1 context)',
  'MT-Fault-ConsumerType': 'Acme.Orders.SubmitOrderConsumer',
  'MT-Fault-MessageType': 'urn:message:Acme.Contracts:SubmitOrder',
  'MT-Fault-Timestamp': '2026-10-28T17:46:00.0000000Z',
  'MT-Fault-RetryCount': 3,
  'MT-Fault-RedeliveryCount': 0,
  'MT-Fault-InputAddress': 'rabbitmq://localhost/submit-order?temporary=false',
  'MT-Fault-Address': 'rabbitmq://localhost/submit-order_error',
  'MT-Host-MachineName': 'orders-7d9f',
  'MT-Host-ProcessName': 'Acme.Orders',
};

async function seed(queue: string, messages: Array<{ id: string; headers: Record<string, unknown> }>) {
  await withChannel('/', async (ch) => {
    for (const m of messages) {
      const options: amqp.Options.Publish = { messageId: m.id, contentType: 'application/json', headers: m.headers };
      ch.sendToQueue(queue, Buffer.from(JSON.stringify({ order: m.id })), options);
    }
    await ch.waitForConfirms();
  });
}

describe('Failure Details from Spring AMQP and MassTransit headers', () => {
  let app: TestApp;
  const open: string[] = [];

  async function startCheckout(queue: string) {
    const res = await app.post(checkoutPath(queue));
    expect(res.status).toBe(201);
    open.push(res.body.checkout.id);
    const checkout = res.body.checkout;
    const message = (id: string) => checkout.messages.find((m: any) => m.messageId === id);
    return { checkout, message };
  }

  beforeAll(async () => {
    await withChannel('/', async (ch) => {
      await ch.assertQueue(errorQueue, { durable: true });
      await ch.assertQueue(skippedQueue, { durable: true });
    });
    app = await startApp({ profiles: [testProfile({ name: 'local' })] });
  });
  afterEach(async () => {
    while (open.length) await app.delete(`/api/checkouts/${open.pop()}`);
    await purgeQueues('/', [...fixtureQueues, errorQueue]);
  });
  afterAll(async () => {
    await app?.close();
    await withChannel('/', async (ch) => {
      await ch.deleteQueue(errorQueue);
      await ch.deleteQueue(skippedQueue);
    });
  });

  it('shows Failure Details and the fallback reason and original queue in a .dlq queue', async () => {
    await seed('orders.dlq', [
      { id: 'spring', headers: springHeaders },
      { id: 'mt', headers: { ...massTransitHeaders, 'MT-Fault-Message': Buffer.from('The payment API timed out') } },
    ]);
    const { checkout, message } = await startCheckout('orders.dlq');

    expect(message('spring')).toMatchObject({
      deadLetterReason: 'Listener method threw exception',
      originalQueue: null,
      failureDetails: { framework: 'spring', originalExchange: 'orders', originalRoutingKey: 'orders.created' },
    });
    expect(message('mt')).toMatchObject({
      deadLetterReason: 'System.TimeoutException: The payment API timed out',
      originalQueue: 'submit-order',
      failureDetails: { framework: 'masstransit', inputQueue: 'submit-order', reason: 'fault' },
    });
    // The MassTransit input queue is a Replay origin (ADR 0010); Spring AMQP names none.
    expect(message('mt').replay.available).toBe(true);
    expect(message('spring').replay.available).toBe(false);

    const view = (await app.get(`/api/checkouts/${checkout.id}/messages/${message('spring').handle}`)).body.message;
    expect(view.failureDetails).toEqual({
      framework: 'spring',
      exceptionType: null,
      message: 'Listener method threw exception',
      stackTrace: springHeaders['x-exception-stacktrace'],
      consumerType: null,
      messageType: null,
      failedAt: null,
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

  it('shows the MassTransit details of a Message in an _error queue, and a skipped one', async () => {
    await seed(errorQueue, [
      { id: 'fault', headers: massTransitHeaders },
      { id: 'skip', headers: { 'MT-Reason': 'skip', 'MT-Fault-InputAddress': 'rabbitmq://localhost/submit-order' } },
    ]);
    const { checkout, message } = await startCheckout(errorQueue);

    const view = (await app.get(`/api/checkouts/${checkout.id}/messages/${message('fault').handle}`)).body.message;
    expect(view).toMatchObject({ deadLetterReason: 'System.TimeoutException: The payment API timed out', originalQueue: 'submit-order' });
    expect(view.failureDetails).toEqual({
      framework: 'masstransit',
      exceptionType: 'System.TimeoutException',
      message: 'The payment API timed out',
      stackTrace: massTransitHeaders['MT-Fault-StackTrace'],
      consumerType: 'Acme.Orders.SubmitOrderConsumer',
      messageType: 'urn:message:Acme.Contracts:SubmitOrder',
      failedAt: '2026-10-28T17:46:00.000Z',
      retryCount: 3,
      redeliveryCount: 0,
      host: { MachineName: 'orders-7d9f', ProcessName: 'Acme.Orders' },
      reason: 'fault',
      originalExchange: null,
      originalRoutingKey: null,
      inputQueue: 'submit-order',
      extra: {
        'MT-Fault-InputAddress': 'rabbitmq://localhost/submit-order?temporary=false',
        'MT-Fault-Address': 'rabbitmq://localhost/submit-order_error',
      },
    });
    expect(message('skip')).toMatchObject({
      deadLetterReason: null,
      originalQueue: 'submit-order',
      failureDetails: { reason: 'skip', exceptionType: null },
    });
  });

  it('prefers x-death over the Failure Details when a Message carries both', async () => {
    await deadLetter(deadLetterRoutes.classic, [{ body: '{}', options: { messageId: 'both', headers: massTransitHeaders } }]);
    const { message } = await startCheckout('orders.dlq');
    expect(message('both')).toMatchObject({
      deadLetterReason: 'rejected',
      originalQueue: 'orders.work',
      failureDetails: { framework: 'masstransit', inputQueue: 'submit-order' },
    });
  });

  it('selects by exception text with the failure filter', async () => {
    await seed('orders.dlq', [
      { id: 'spring', headers: springHeaders },
      { id: 'mt', headers: massTransitHeaders },
      { id: 'plain', headers: { tenant: 'timeout' } },
    ]);
    const { checkout, message } = await startCheckout('orders.dlq');
    const matching = async (value: string) =>
      (await app.post(`/api/checkouts/${checkout.id}/matching`, { filter: [{ kind: 'failure', value }] })).body;

    expect(await matching('TIMEOUTEXCEPTION')).toEqual({ handles: [message('mt').handle], count: 1 });
    expect(await matching('threw exception')).toEqual({ handles: [message('spring').handle], count: 1 });
    expect((await matching('exception')).handles).toEqual([message('spring').handle, message('mt').handle]);
  });

  it('lists _error queues first as dead-letter queues, but not _skipped queues', async () => {
    const { queues } = (await app.get('/api/profiles/local/vhosts/%2F/queues')).body;
    const byName = Object.fromEntries(queues.map((q: any) => [q.name, q]));
    expect(byName[errorQueue]).toMatchObject({ deadLetterQueue: true, deadLetteredFrom: [], matchesDefaultFilter: false });
    expect(byName[skippedQueue]).toMatchObject({ deadLetterQueue: false });
    const firstOther = queues.findIndex((q: any) => !q.deadLetterQueue);
    expect(queues.findIndex((q: any) => q.name === errorQueue)).toBeLessThan(firstOther);
  });

  it('carries the Failure Details in the export line', async () => {
    await seed(errorQueue, [{ id: 'fault', headers: massTransitHeaders }]);
    const { checkout } = await startCheckout(errorQueue);
    const res = await fetch(`${app.baseUrl}/api/checkouts/${checkout.id}/export`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    const line = JSON.parse((await res.text()).trim());
    expect(line.v).toBe(1);
    expect(line.failureDetails).toMatchObject({ framework: 'masstransit', exceptionType: 'System.TimeoutException', inputQueue: 'submit-order' });
  });
});
