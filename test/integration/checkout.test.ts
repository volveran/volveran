// Checkout through the HTTP API against the test broker: holding exactly the
// ready Messages, the limits, one Checkout per queue and per Operator,
// ending it, and inspecting the held Messages. The broker is checked
// independently over AMQP.
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import * as amqp from 'amqplib';
import { lockQueueName } from '../../src/server/triage/checkout-lock.js';
import {
  connect,
  drain,
  purgeQueues,
  readyCount,
  readyMessageIds,
  seedMessages,
  startApp,
  testProfile,
  withChannel,
  brokerUsers,
  deadLetter,
  deadLetterRoutes,
  testOperator,
  eventually,
  management,
  vhostPath,
  waitForReady,
  type TestApp,
} from './harness.js';

/** Every ready Message of `queue` (taken and put back with nack), with its x-delivery-count. */
async function readyMessages(queue: string): Promise<Array<{ id: string; deliveryCount: unknown }>> {
  return withChannel('/', async (ch) => {
    const taken: amqp.GetMessage[] = [];
    for (;;) {
      const m = await ch.get(queue, { noAck: false });
      if (!m) break;
      taken.push(m);
    }
    for (const m of taken) ch.nack(m, false, true);
    await ch.checkQueue(queue);
    return taken.map((m) => ({ id: String(m.properties.messageId), deliveryCount: m.properties.headers?.['x-delivery-count'] }));
  });
}

/** Waits until the management API reports `count` ready Messages of `queue`, with their size. */
async function waitForReadyStats(queue: string, count: number): Promise<void> {
  await eventually(async () => {
    const { body } = await management(`/queues/${vhostPath('/')}/${encodeURIComponent(queue)}`);
    expect([body.messages_ready, body.message_bytes_ready > 0]).toEqual([count, true]);
  }, 25_000);
}

const checkoutPath = (queue: string, vhost = '/') =>
  `/api/profiles/local/vhosts/${encodeURIComponent(vhost)}/queues/${encodeURIComponent(queue)}/checkouts`;

const queues = ['orders.dlq', 'payments.dlq'];
const seededQueues = [...queues, 'payments.work'];

describe('Checkout', () => {
  let app: TestApp;
  const open: Array<{ app: TestApp; id: string }> = [];

  async function startCheckout(queue: string, on: TestApp = app) {
    const res = await on.post(checkoutPath(queue));
    if (res.status === 201) open.push({ app: on, id: res.body.checkout.id });
    return res;
  }

  async function endCheckout(id: string, on: TestApp = app) {
    const i = open.findIndex((c) => c.id === id);
    if (i >= 0) open.splice(i, 1);
    return on.delete(`/api/checkouts/${id}`);
  }

  beforeAll(async () => {
    app = await startApp({ profiles: [testProfile({ name: 'local' })] });
  });
  afterEach(async () => {
    while (open.length) {
      const c = open.pop()!;
      // An app a test already closed has ended its Checkouts itself.
      await c.app.delete(`/api/checkouts/${c.id}`).catch(() => {});
    }
    await purgeQueues('/', seededQueues);
  });
  afterAll(async () => {
    await app?.close();
  });

  it.each(queues)('holds exactly the Messages that were ready in %s when it started', async (queue) => {
    await purgeQueues('/', [queue]);
    await seedMessages('/', queue, 4);

    const res = await startCheckout(queue);

    expect(res.status).toBe(201);
    expect(res.body.checkout).toMatchObject({ queue, status: 'active', readyAtStart: 4, heldCount: 4, limitedBy: null });
    expect(res.body.checkout.messages.map((m: any) => m.messageId)).toEqual([0, 1, 2, 3].map((i) => `${queue}-${i}`));
    expect(await readyCount('/', queue)).toBe(0);
  });

  it.each(queues)('leaves Messages published to %s during the Checkout in the queue afterwards', async (queue) => {
    await seedMessages('/', queue, 2);
    const { checkout } = (await startCheckout(queue)).body;
    expect(checkout.messages).toHaveLength(2);

    await withChannel('/', async (ch) => {
      ch.sendToQueue(queue, Buffer.from('late'), { messageId: 'late-arrival' });
      await ch.waitForConfirms();
    });
    expect(await readyMessageIds('/', queue)).toEqual(['late-arrival']);
    expect((await app.get(`/api/checkouts/${checkout.id}`)).body.checkout.heldCount).toBe(2);

    await endCheckout(checkout.id);
    await waitForReady('/', queue, 3);
    expect((await readyMessageIds('/', queue)).sort()).toEqual([`${queue}-0`, `${queue}-1`, 'late-arrival'].sort());
  });

  it.each(queues)('returns every Message to %s in its original order when the Checkout ends', async (queue) => {
    await seedMessages('/', queue, 5);
    // A reject with requeue gives a quorum Message an x-delivery-count to keep.
    await withChannel('/', async (ch) => {
      const m = await ch.get(queue, { noAck: false });
      if (m) ch.reject(m, true);
      await ch.checkQueue(queue);
    });
    const before = await readyMessages(queue);
    if (queue === 'payments.dlq') expect(before.some((m) => m.deliveryCount === 1)).toBe(true);
    const { checkout } = (await startCheckout(queue)).body;
    expect(await readyCount('/', queue)).toBe(0);

    const ended = await endCheckout(checkout.id);

    expect(ended.status).toBe(200);
    expect(ended.body.checkout).toMatchObject({ status: 'ended', endReason: 'operator', heldCount: 0, messages: [] });
    // Same order, and on the quorum queue x-delivery-count is unchanged.
    await waitForReady('/', queue, 5);
    expect(await readyMessages(queue)).toEqual(before);
    // The queue is free again.
    expect((await startCheckout(queue)).status).toBe(201);
  });

  it('returns every Message when the app shuts down', async () => {
    await seedMessages('/', 'orders.dlq', 2);
    const other = await startApp({ profiles: [testProfile({ name: 'local' })] });
    expect((await other.post(checkoutPath('orders.dlq'))).status).toBe(201);
    expect(await readyCount('/', 'orders.dlq')).toBe(0);

    await other.close();

    expect(await readyMessageIds('/', 'orders.dlq')).toEqual(['orders.dlq-0', 'orders.dlq-1']);
  });

  it('checks out an empty queue: nothing held, but the queue is still locked', async () => {
    const { checkout } = (await startCheckout('orders.dlq')).body;
    expect(checkout).toMatchObject({ readyAtStart: 0, heldCount: 0, messages: [] });
    const other = await startApp({ profiles: [testProfile({ name: 'local' })], env: { VOLVERAN_OPERATOR: 'bob' } });
    try {
      expect((await other.post(checkoutPath('orders.dlq'))).body.error.code).toBe('checkout_in_progress');
    } finally {
      await other.close();
    }
  });

  describe('limits', () => {
    let limited: TestApp;
    afterEach(async () => {
      await limited?.close();
    });

    it.each(queues)('holds at most the Message limit of %s, returning the rest in order', async (queue) => {
      limited = await startApp({ profiles: [testProfile({ name: 'local' })], checkoutLimits: { maxMessages: 3 } });
      // Not read before the Checkout: Messages returned to a quorum queue go
      // ahead of the rest, so looking would change the order under test.
      await seedMessages('/', queue, 5);

      const { checkout } = (await startCheckout(queue, limited)).body;

      expect(checkout).toMatchObject({ readyAtStart: 5, heldCount: 3, limitedBy: 'messages' });
      expect(checkout.limits.maxMessages).toBe(3);
      expect(checkout.messages.map((m: any) => m.messageId)).toEqual([0, 1, 2].map((i) => `${queue}-${i}`));
      // The other 2 stay ready (a passive declare: taking them to look would reorder a quorum queue).
      await waitForReady('/', queue, 2);

      await endCheckout(checkout.id, limited);
      await waitForReady('/', queue, 5);
      expect(await readyMessageIds('/', queue)).toEqual([0, 1, 2, 3, 4].map((i) => `${queue}-${i}`));
    });

    it.each(queues)('holds at most the byte limit of %s, returning the rest in order', async (queue) => {
      // Seeded bodies are 7 bytes ({"n":0}): 3 fit in 25 bytes.
      limited = await startApp({ profiles: [testProfile({ name: 'local' })], checkoutLimits: { maxBytes: 25 } });
      // Not read before the Checkout: Messages returned to a quorum queue go
      // ahead of the rest, so looking would change the order under test.
      await seedMessages('/', queue, 5);
      // With fresh management statistics, so the result never depends on how
      // stale they are: a quorum queue reports more bytes than the bodies hold.
      await waitForReadyStats(queue, 5);

      const { checkout } = (await startCheckout(queue, limited)).body;

      expect(checkout).toMatchObject({ readyAtStart: 5, heldCount: 3, heldBytes: 21, limitedBy: 'bytes' });
      expect(checkout.messages.map((m: any) => m.messageId)).toEqual([0, 1, 2].map((i) => `${queue}-${i}`));

      await endCheckout(checkout.id, limited);
      await waitForReady('/', queue, 5);
      expect(await readyMessageIds('/', queue)).toEqual([0, 1, 2, 3, 4].map((i) => `${queue}-${i}`));
    });
  });

  describe('large Messages', () => {
    const MB = 1024 * 1024;
    let limited: TestApp;
    afterEach(async () => {
      await limited?.close();
    });

    async function seedLargeMessages(queue: string, count: number) {
      await withChannel('/', async (ch) => {
        for (let i = 0; i < count; i++) {
          ch.sendToQueue(queue, Buffer.alloc(MB, i % 256), { messageId: `${queue}-${i}`, persistent: true });
          await ch.waitForConfirms();
        }
      });
    }

    it.each(queues)(
      'takes from %s no more than a window of Messages past the byte limit, and returns them all in order',
      async (queue) => {
        let collected: { windows: number[]; overflow: number } | undefined;
        limited = await startApp({
          profiles: [testProfile({ name: 'local' })],
          checkoutLimits: { maxBytes: 5 * MB },
          checkoutTestHooks: { afterCollect: async (_ref, c) => void (collected = c) },
        });
        await seedLargeMessages(queue, 50);

        const { checkout } = (await startCheckout(queue, limited)).body;

        expect(checkout).toMatchObject({ readyAtStart: 50, heldCount: 5, heldBytes: 5 * MB, limitedBy: 'bytes' });
        expect(checkout.messages.map((m: any) => m.messageId)).toEqual([0, 1, 2, 3, 4].map((i) => `${queue}-${i}`));
        // Past the byte limit, at most the last window was delivered; the rest never left the queue.
        const lastWindow = collected!.windows.at(-1)!;
        expect(collected!.overflow).toBeGreaterThan(0);
        expect(collected!.overflow).toBeLessThanOrEqual(lastWindow);
        expect(Math.max(...collected!.windows)).toBeLessThanOrEqual(5);
        await waitForReady('/', queue, 50 - 5 - collected!.overflow);

        await endCheckout(checkout.id, limited);
        await waitForReady('/', queue, 50);
        expect(await readyMessageIds('/', queue)).toEqual(Array.from({ length: 50 }, (_, i) => `${queue}-${i}`));
      },
      60_000,
    );
  });

  describe('one Checkout per queue', () => {
    it.each(queues)('refuses a second Checkout of %s in the same instance and names the holder', async (queue) => {
      await seedMessages('/', queue, 1);
      const first = (await startCheckout(queue)).body.checkout;
      const other = await startApp({ profiles: [testProfile({ name: 'local' })], env: { VOLVERAN_OPERATOR: 'bob' } });
      try {
        // Same instance, different Operator: the in-process lock.
        const second = await startCheckout(queue, other);
        expect(second.status).toBe(409);
        expect(second.body.error).toMatchObject({
          code: 'checkout_in_progress',
          holder: { operator: testOperator, since: first.startedAt },
        });
        expect(second.body.error.message).toContain(`Queue "${queue}" in vhost "/" is already checked out: ${testOperator}`);
      } finally {
        await other.close();
      }
    });

    it('has stopped counting its own consumers by the time ending a Checkout answers', async () => {
      // Many Messages, so a quorum queue has much to do when the Checkout closes. Goes red only with the broker short of CPU.
      await seedMessages('/', 'payments.dlq', 200);
      const raw = await connect();
      try {
        const ch = await raw.createChannel();
        for (let i = 0; i < 20; i++) {
          const { checkout } = (await startCheckout('payments.dlq')).body;
          await endCheckout(checkout.id);
          expect((await ch.checkQueue('payments.dlq')).consumerCount).toBe(0);
        }
      } finally {
        await raw.close();
      }
    }, 90_000);

    it('has freed the broker lock by the time ending a Checkout answers', async () => {
      // An open connection, so the declare follows the end with no handshake in between.
      const raw = await connect();
      const lockQueue = lockQueueName('orders.dlq');
      try {
        for (let i = 0; i < 40; i++) {
          const { checkout } = (await startCheckout('orders.dlq')).body;
          await endCheckout(checkout.id);
          const ch = await raw.createChannel();
          await ch.assertQueue(lockQueue, { exclusive: true, autoDelete: true, durable: false });
          await ch.deleteQueue(lockQueue);
          await ch.close();
        }
      } finally {
        await raw.close();
      }
    }, 60_000);

    it('refuses a Checkout of a queue held by another Volverán instance, through the broker lock', async () => {
      await seedMessages('/', 'payments.dlq', 1);
      const other = await startApp({ profiles: [testProfile({ name: 'local' })], env: { VOLVERAN_OPERATOR: 'bob' } });
      try {
        const first = (await startCheckout('payments.dlq', other)).body.checkout;

        const second = await startCheckout('payments.dlq');

        expect(second.status).toBe(409);
        expect(second.body.error).toMatchObject({
          code: 'checkout_in_progress',
          holder: { operator: 'bob', since: first.startedAt },
        });
        // The refused start left the queue alone.
        expect((await other.get(`/api/checkouts/${first.id}`)).body.checkout).toMatchObject({ status: 'active', heldCount: 1 });
        await endCheckout(first.id, other);
        await waitForReady('/', 'payments.dlq', 1);
        expect((await startCheckout('payments.dlq')).status).toBe(201);
      } finally {
        await other.close();
      }
    });

    it('shows who holds a queue in the queue list, and not the lock queue itself', async () => {
      const { checkout } = (await startCheckout('orders.dlq')).body;

      const list = (await app.get('/api/profiles/local/vhosts/%2F/queues')).body.queues;

      expect(list.find((q: any) => q.name === 'orders.dlq').checkedOutBy).toEqual({
        operator: testOperator,
        since: checkout.startedAt,
      });
      expect(list.find((q: any) => q.name === 'payments.dlq').checkedOutBy).toBeNull();
      expect(list.map((q: any) => q.name)).not.toContain('volveran.checkout.orders.dlq');
    });

    it('explains a missing configure permission on ^volveran\\.', async () => {
      const noLock = await startApp({
        profiles: [testProfile({ name: 'local', username: brokerUsers.noLock.username, passwordEnv: 'NOLOCK_PW' })],
        env: { NOLOCK_PW: brokerUsers.noLock.password },
      });
      try {
        await seedMessages('/', 'orders.dlq', 1);
        const res = await startCheckout('orders.dlq', noLock);
        expect(res.status).toBe(403);
        expect(res.body.error.code).toBe('lock_not_permitted');
        expect(res.body.error.message).toContain('configure permission');
        expect(res.body.error.message).toContain('^volveran\\.');
        expect(await readyCount('/', 'orders.dlq')).toBe(1);
      } finally {
        await noLock.close();
      }
    });
  });

  it('allows one active Checkout per Operator', async () => {
    const first = (await startCheckout('orders.dlq')).body.checkout;

    const second = await startCheckout('payments.dlq');

    expect(second.status).toBe(409);
    expect(second.body.error).toMatchObject({ code: 'operator_has_checkout', checkoutId: first.id, queue: 'orders.dlq' });
    expect((await app.get('/api/session')).body.checkoutId).toBe(first.id);
    await endCheckout(first.id);
    expect((await app.get('/api/session')).body.checkoutId).toBeNull();
    expect((await startCheckout('payments.dlq')).status).toBe(201);
  });

  it('refuses to check out a stream queue', async () => {
    const res = await startCheckout('events.stream');
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('queue_not_checkoutable');
  });

  it('reports a queue that does not exist', async () => {
    const res = await startCheckout('no.such.queue');
    expect([res.status, res.body.error.code]).toEqual([404, 'queue_not_found']);
  });

  describe('Messages', () => {
    it('lists a dead-lettered Message and shows its detail: properties, headers, x-death and body', async () => {
      await deadLetter(deadLetterRoutes.quorum, [
        {
          body: '{"payment":7}',
          options: {
            messageId: 'pay-7',
            contentType: 'application/json',
            correlationId: 'corr-7',
            timestamp: 1792139557,
            headers: { tenant: 'acme' },
          },
        },
      ]);

      const { checkout } = (await startCheckout('payments.dlq')).body;

      expect(checkout).toMatchObject({ queueType: 'quorum', deliveryLimit: 5 });
      expect(checkout.messages).toEqual([
        {
          handle: expect.any(Number),
          messageId: 'pay-7',
          routingKey: 'payments.captured',
          timestamp: '2026-10-16T08:32:37.000Z',
          deadLetterReason: 'rejected',
          originalQueue: 'payments.work',
          size: 13,
          deliveryBudget: { remaining: 5, warning: null },
          decision: { kind: 'keep' },
          replay: { available: true },
          diedAgain: null,
          rule: null,
          failureDetails: null,
        },
      ]);

      const res = await app.get(`/api/checkouts/${checkout.id}/messages/${checkout.messages[0].handle}`);

      expect(res.status).toBe(200);
      const m = res.body.message;
      expect(m.properties).toMatchObject({ messageId: 'pay-7', contentType: 'application/json', correlationId: 'corr-7' });
      expect(m.headers).toMatchObject({ tenant: 'acme', 'x-first-death-queue': 'payments.work' });
      expect(m.xDeath).toEqual([
        {
          queue: 'payments.work',
          reason: 'rejected',
          count: 1,
          time: expect.stringMatching(/^\d{4}-\d\d-\d\dT/),
          exchange: 'payments',
          routingKeys: ['payments.captured'],
          originalExpiration: null,
        },
      ]);
      expect(m).toMatchObject({ deliveryCount: 0, deliveryLimit: 5 });
      expect(m.body).toEqual({ kind: 'json', size: 13, text: '{\n  "payment": 7\n}' });
    });

    it('warns about a quorum Message with a Delivery Budget of 1', async () => {
      await seedMessages('/', 'payments.dlq', 1);
      // Four rejects with requeue: x-delivery-count 4 of the queue's limit of 5.
      await withChannel('/', async (ch) => {
        for (let i = 0; i < 4; i++) {
          const m = await ch.get('payments.dlq', { noAck: false });
          if (m) ch.reject(m, true);
          await ch.checkQueue('payments.dlq');
        }
      });

      const { checkout } = (await startCheckout('payments.dlq')).body;

      expect(checkout.messages[0].deliveryBudget).toEqual({
        remaining: 1,
        warning: 'Delivery Budget 1: if this Checkout is lost, the broker drops this Message.',
      });
    });

    it('has no Delivery Budget on a classic queue', async () => {
      await seedMessages('/', 'orders.dlq', 1);
      const { checkout } = (await startCheckout('orders.dlq')).body;
      expect(checkout.messages[0].deliveryBudget).toBeNull();
      expect(checkout.deliveryLimit).toBeNull();
    });

    it('lists Messages that share a message_id as separate entries', async () => {
      await withChannel('/', async (ch) => {
        for (const body of ['first', 'second']) ch.sendToQueue('orders.dlq', Buffer.from(body), { messageId: 'dup' });
        await ch.waitForConfirms();
      });

      const { messages } = (await startCheckout('orders.dlq')).body.checkout;

      expect(messages.map((m: any) => m.messageId)).toEqual(['dup', 'dup']);
      expect(new Set(messages.map((m: any) => m.handle)).size).toBe(2);
    });

    it('shows a text body as-is and a binary body as hex and base64', async () => {
      await withChannel('/', async (ch) => {
        ch.sendToQueue('orders.dlq', Buffer.from('order 42 failed'), { messageId: 'text', contentType: 'text/plain' });
        ch.sendToQueue('orders.dlq', Buffer.from([0, 1, 254, 255]), { messageId: 'bin' });
        await ch.waitForConfirms();
      });
      const { checkout } = (await startCheckout('orders.dlq')).body;
      const detail = async (i: number) =>
        (await app.get(`/api/checkouts/${checkout.id}/messages/${checkout.messages[i].handle}`)).body.message;

      expect((await detail(0)).body).toEqual({ kind: 'text', size: 15, text: 'order 42 failed' });
      expect((await detail(1)).body).toEqual({ kind: 'binary', size: 4, hex: '0001feff', base64: 'AAH+/w==' });
    });

    it('reports an unknown Message handle or Checkout', async () => {
      await seedMessages('/', 'orders.dlq', 1);
      const { checkout } = (await startCheckout('orders.dlq')).body;
      expect((await app.get(`/api/checkouts/${checkout.id}/messages/999`)).body.error.code).toBe('message_not_found');
      expect((await app.get(`/api/checkouts/${checkout.id}/messages/abc`)).status).toBe(404);
      expect((await app.get('/api/checkouts/nope')).body.error.code).toBe('checkout_not_found');
    });
  });
});
