// A Checkout never holds Messages forever (ADR 0006): it ends itself at its
// time limit, or when the browser stops sending heartbeats. The time limit and
// heartbeat window are set to seconds here; production defaults are 30 and 2
// minutes.
import * as amqp from 'amqplib';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { eventually, purgeQueues, seedMessages, sleep, startApp, testProfile, withChannel, type TestApp } from './harness.js';

const checkoutPath = (queue: string) => `/api/profiles/local/vhosts/%2F/queues/${encodeURIComponent(queue)}/checkouts`;

/** Message ids and x-delivery-count of every ready Message (taken and put back with nack). */
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

const queues = ['orders.dlq', 'payments.dlq'];

describe('Checkout time limit', () => {
  let app: TestApp;
  beforeAll(async () => {
    app = await startApp({
      profiles: [testProfile({ name: 'local' })],
      checkoutTiming: { timeLimitMs: 2_000, heartbeatWindowMs: 60_000 },
    });
  });
  afterEach(async () => {
    await purgeQueues('/', queues);
  });
  afterAll(async () => {
    await app?.close();
  });

  it.each(queues)('ends a Checkout of %s at its time limit, with every Message back and x-delivery-count unchanged', async (queue) => {
    await seedMessages('/', queue, 3);
    const before = await readyMessages(queue);
    const started = await app.post(checkoutPath(queue));
    expect(started.status).toBe(201);
    const { checkout } = started.body;
    expect(checkout.timeLimitMs).toBe(2_000);
    expect(Date.parse(checkout.expiresAt) - Date.parse(checkout.startedAt)).toBe(2_000);
    expect(checkout.remainingMs).toBeGreaterThan(0);
    expect(checkout.remainingMs).toBeLessThanOrEqual(2_000);

    const ended = await eventually(async () => {
      const res = await app.get(`/api/checkouts/${checkout.id}`);
      expect(res.body.checkout.status).toBe('ended');
      return res.body.checkout;
    }, 10_000);

    expect(ended.endReason).toBe('time-limit');
    expect(ended.remainingMs).toBe(0);
    expect(await readyMessages(queue)).toEqual(before);
    expect((await app.get('/api/session')).body.checkoutId).toBeNull();
  });
});

describe('Checkout heartbeat', () => {
  let app: TestApp;
  beforeAll(async () => {
    app = await startApp({
      profiles: [testProfile({ name: 'local' })],
      checkoutTiming: { timeLimitMs: 60_000, heartbeatWindowMs: 1_500 },
    });
  });
  afterEach(async () => {
    await purgeQueues('/', queues);
  });
  afterAll(async () => {
    await app?.close();
  });

  it('ends the Checkout when no heartbeat arrives within the window; reading it is not a heartbeat', async () => {
    await seedMessages('/', 'orders.dlq', 2);
    const { checkout } = (await app.post(checkoutPath('orders.dlq'))).body;
    expect(checkout.heartbeatWindowMs).toBe(1_500);

    const ended = await eventually(async () => {
      const res = await app.get(`/api/checkouts/${checkout.id}`);
      expect(res.body.checkout.status).toBe('ended');
      return res.body.checkout;
    }, 10_000);

    expect(ended.endReason).toBe('no-heartbeat');
    expect((await readyMessages('orders.dlq')).map((m) => m.id)).toEqual(['orders.dlq-0', 'orders.dlq-1']);
  });

  it('keeps the Checkout while heartbeats arrive', async () => {
    await seedMessages('/', 'orders.dlq', 1);
    const { checkout } = (await app.post(checkoutPath('orders.dlq'))).body;

    for (let i = 0; i < 6; i++) {
      await sleep(500);
      const beat = await app.post(`/api/checkouts/${checkout.id}/heartbeat`);
      expect(beat.status).toBe(200);
      expect(beat.body.checkout.status).toBe('active');
    }

    expect((await app.delete(`/api/checkouts/${checkout.id}`)).body.checkout.endReason).toBe('operator');
  });
});
