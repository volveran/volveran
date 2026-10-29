// The Replay origin from framework headers (ADR 0010) through the HTTP API,
// against the real broker: a MassTransit Message in a `_error` queue Replays
// to its input queue only, without the framework's headers (the Audit Entry
// keeps them); a skipped one and a Spring AMQP one cannot be Replayed, the
// latter suggesting a Move to its original exchange, which works. The Canary
// of a MassTransit Replay is watched on the `_error` exchange.
import type * as amqp from 'amqplib';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  applyAndWait,
  drain,
  eventually,
  fixtureQueues,
  purgeQueues,
  readyCount,
  readyMessageIds,
  startApp,
  testProfile,
  withChannel,
  type TestApp,
} from './harness.js';

// MassTransit's RabbitMQ topology for a receive endpoint `framework.submit-order`:
// faults are published to the fanout exchange `<queue>_error`, bound to the queue `<queue>_error`.
const inputQueue = 'framework.submit-order';
const errorQueue = `${inputQueue}_error`;
const checkoutPath = (queue: string) => `/api/profiles/local/vhosts/%2F/queues/${encodeURIComponent(queue)}/checkouts`;
const REPLAY = { kind: 'replay' };

/** As MassTransit's RabbitMQ transport writes them when it moves a Message to `<queue>_error`. */
const massTransitHeaders = {
  'MT-Reason': 'fault',
  'MT-Fault-ExceptionType': 'System.TimeoutException',
  'MT-Fault-Message': 'The payment API timed out',
  'MT-Fault-StackTrace': '   at Acme.Orders.SubmitOrderConsumer.Consume(ConsumeContext`1 context)',
  'MT-Fault-ConsumerType': 'Acme.Orders.SubmitOrderConsumer',
  'MT-Fault-Timestamp': '2026-10-28T17:46:00.0000000Z',
  'MT-Fault-RetryCount': 3,
  'MT-Fault-InputAddress': `rabbitmq://localhost/${inputQueue}?temporary=false`,
  'MT-Host-MachineName': 'orders-7d9f',
};

/** As RepublishMessageRecoverer writes them (spring-amqp). */
const springHeaders = {
  'x-exception-message': 'Listener method threw exception',
  'x-exception-stacktrace': 'org.springframework.amqp.rabbit.support.ListenerExecutionFailedException',
  'x-original-exchange': 'orders',
  'x-original-routingKey': 'orders.created',
};

const FRAMEWORK_HEADER = /^(MT-Fault-|MT-Host-|MT-Reason$|x-exception-|x-original-exchange$|x-original-routingKey$)/;

async function seed(queue: string, messages: Array<{ id: string; headers: Record<string, unknown> }>) {
  await withChannel('/', async (ch) => {
    for (const m of messages) {
      ch.sendToQueue(queue, Buffer.from(JSON.stringify({ order: m.id })), { messageId: m.id, headers: { tenant: 'acme', ...m.headers } });
    }
    await ch.waitForConfirms();
  });
}

describe('Replay origin from framework headers', () => {
  let app: TestApp;
  const open: string[] = [];

  async function startCheckout(queue: string, profile = 'local') {
    const res = await app.post(checkoutPath(queue).replace('/local/', `/${profile}/`));
    expect(res.status).toBe(201);
    const checkout = res.body.checkout;
    open.push(checkout.id);
    const message = (id: string) => checkout.messages.find((m: any) => m.messageId === id);
    return { id: checkout.id as string, checkout, message };
  }
  const decide = (id: string, handles: number[], decision: unknown) => app.post(`/api/checkouts/${id}/decisions`, { handles, decision });
  const apply = (id: string) => applyAndWait(app, `/api/checkouts/${id}/apply`, { confirm: true });
  const auditEntry = async (checkoutId: string) => {
    const { entries } = (await app.get(`/api/audit-entries?checkoutId=${checkoutId}`)).body;
    expect(entries).toHaveLength(1);
    return { listed: entries[0], entry: (await app.get(`/api/audit-entries/${entries[0].id}`)).body.entry };
  };

  beforeAll(async () => {
    await withChannel('/', async (ch) => {
      await ch.assertQueue(inputQueue, { durable: true });
      await ch.assertExchange(errorQueue, 'fanout', { durable: true });
      await ch.assertQueue(errorQueue, { durable: true });
      await ch.bindQueue(errorQueue, errorQueue, '');
    });
    app = await startApp({
      profiles: [testProfile({ name: 'local' }), testProfile({ name: 'quick', canary: { watchWindow: '5s' } })],
      checkoutTiming: { timeLimitMs: 120_000 },
    });
  });
  afterEach(async () => {
    while (open.length) await app.delete(`/api/checkouts/${open.pop()}`);
    await purgeQueues('/', [...fixtureQueues, inputQueue, errorQueue]);
  });
  afterAll(async () => {
    await app?.close();
    await withChannel('/', async (ch) => {
      await ch.deleteQueue(inputQueue);
      await ch.deleteQueue(errorQueue);
      await ch.deleteExchange(errorQueue);
    });
  });

  it('Replays a MassTransit Message from its _error queue to its input queue only, without the framework headers, which the Audit Entry keeps', async () => {
    await seed(errorQueue, [{ id: 'fault', headers: massTransitHeaders }]);
    const { id, message } = await startCheckout(errorQueue);
    expect(message('fault').replay).toEqual({ available: true });

    expect((await decide(id, [message('fault').handle], REPLAY)).body.rejected).toEqual([]);
    const applied = await apply(id);
    expect(applied.body.outcomes).toEqual([expect.objectContaining({ messageId: 'fault', status: 'done' })]);

    const arrived = await withChannel('/', (ch) => drain(ch, inputQueue));
    expect(arrived.map((m) => m.properties.messageId)).toEqual(['fault']);
    expect(await readyCount('/', errorQueue)).toBe(0);
    const headers = arrived[0]!.properties.headers ?? {};
    expect(Object.keys(headers).filter((h) => FRAMEWORK_HEADER.test(h))).toEqual([]);
    expect(headers).toMatchObject({ tenant: 'acme', 'x-volveran-from': errorQueue });

    const { listed, entry } = await auditEntry(id);
    expect(listed).toMatchObject({
      action: 'replay',
      destination: { exchange: '', routingKey: inputQueue, queue: inputQueue },
      outcome: 'done',
    });
    expect(entry.message.headers).toMatchObject({
      'MT-Reason': 'fault',
      'MT-Fault-ExceptionType': 'System.TimeoutException',
      'MT-Fault-InputAddress': massTransitHeaders['MT-Fault-InputAddress'],
      'MT-Host-MachineName': 'orders-7d9f',
    });
  });

  it('cannot Replay a skipped MassTransit Message or a Spring AMQP one; the latter suggests a Move to its original exchange', async () => {
    await seed(errorQueue, [
      { id: 'skip', headers: { 'MT-Reason': 'skip', 'MT-Fault-InputAddress': `rabbitmq://localhost/${inputQueue}` } },
      { id: 'spring', headers: springHeaders },
    ]);
    const { id, message } = await startCheckout(errorQueue);

    expect(message('skip').replay).toEqual({ available: false, reason: expect.stringContaining('no consumer handled this Message type') });
    expect(message('spring').replay).toEqual({
      available: false,
      reason: expect.stringContaining('exchange "orders" with the routing key "orders.created"'),
      suggestedMove: { exchange: 'orders', routingKey: 'orders.created' },
    });
    const res = await decide(id, [message('skip').handle, message('spring').handle], REPLAY);
    expect(res.body.rejected).toEqual([
      { handle: message('skip').handle, reason: message('skip').replay.reason },
      { handle: message('spring').handle, reason: message('spring').replay.reason },
    ]);
  });

  it('Moves a Spring AMQP Message to its original exchange and routing key, without the framework headers', async () => {
    await seed('orders.dlq', [{ id: 'spring', headers: springHeaders }]);
    const { id, message } = await startCheckout('orders.dlq');
    const { suggestedMove } = message('spring').replay;

    expect((await decide(id, [message('spring').handle], { kind: 'move', destination: suggestedMove })).body.rejected).toEqual([]);
    expect((await apply(id)).body.outcomes).toEqual([expect.objectContaining({ messageId: 'spring', status: 'done' })]);

    const arrived = await withChannel('/', (ch) => drain(ch, 'orders.work'));
    expect(arrived.map((m) => [m.properties.messageId, m.fields.routingKey])).toEqual([['spring', 'orders.created']]);
    expect(Object.keys(arrived[0]!.properties.headers ?? {}).filter((h) => FRAMEWORK_HEADER.test(h))).toEqual([]);
    expect((await auditEntry(id)).entry.message.headers).toMatchObject(springHeaders);
  });

  it('watches the Canary of a MassTransit Replay on the _error exchange: rejected by its consumer, it comes back and is died_again', async () => {
    await seed(errorQueue, [
      { id: 'canary', headers: massTransitHeaders },
      { id: 'second', headers: massTransitHeaders },
    ]);
    const { id, checkout } = await startCheckout(errorQueue, 'quick');
    await decide(id, checkout.messages.map((m: any) => m.handle), REPLAY);
    expect((await app.get(`/api/checkouts/${id}`)).body.checkout.applyConfirmation.canary.candidates[0].watch).toEqual({ watchable: true });

    expect((await app.post(`/api/checkouts/${id}/apply`, { confirm: true, canary: true })).status).toBe(202);
    await eventually(async () => {
      const view = (await app.get(`/api/checkouts/${id}`)).body.checkout;
      if (view.applyProgress?.phase !== 'canary_watch') throw new Error('not watching yet');
    });

    // The consumer fails it again: MassTransit publishes the fault, headers kept, to the _error exchange.
    await withChannel('/', async (ch) => {
      const m: amqp.GetMessage = await eventually(async () => {
        const got = await ch.get(inputQueue, { noAck: false });
        if (!got) throw new Error(`nothing in ${inputQueue} yet`);
        return got;
      });
      ch.publish(errorQueue, '', m.content, {
        ...m.properties,
        headers: { ...m.properties.headers, ...massTransitHeaders, 'MT-Fault-Message': 'Still timing out' },
      });
      await ch.waitForConfirms();
      ch.ack(m);
    });

    const done = await eventually(async () => {
      const view = (await app.get(`/api/checkouts/${id}`)).body.checkout;
      if (view.applyProgress?.phase !== 'canary_done') throw new Error('Canary not settled yet');
      return view;
    });
    expect(done.canary).toMatchObject({
      status: 'died_again',
      deadLetterReason: 'System.TimeoutException: Still timing out',
      failureDetails: { framework: 'masstransit', message: 'Still timing out' },
    });
    // The _error queue got its own copy; the second Message is still held.
    expect(await readyMessageIds('/', errorQueue)).toEqual(['canary']);
    expect(done.heldCount).toBe(1);
  });

  it('leaves the Canary unwatched when the _error exchange is missing', async () => {
    const orphan = 'framework.orphan_error';
    await withChannel('/', (ch) => ch.assertQueue(orphan, { durable: true }));
    try {
      await seed(orphan, [{ id: 'fault', headers: { ...massTransitHeaders, 'MT-Fault-InputAddress': 'rabbitmq://localhost/framework.orphan' } }]);
      const { id, message } = await startCheckout(orphan);
      await decide(id, [message('fault').handle], REPLAY);
      const confirmation = (await app.get(`/api/checkouts/${id}`)).body.checkout.applyConfirmation.canary;
      expect(confirmation.candidates).toEqual([
        { handle: message('fault').handle, watch: { watchable: false, reason: expect.stringContaining('"framework.orphan_error", which does not exist') } },
      ]);
    } finally {
      while (open.length) await app.delete(`/api/checkouts/${open.pop()}`);
      await withChannel('/', (ch) => ch.deleteQueue(orphan));
    }
  });
});
