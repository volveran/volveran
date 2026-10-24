// Live-consumer warning: a Checkout of a queue other consumers read would
// compete with them for Messages, so starting one needs an explicit override.
// The consumer count comes from a passive declare (exact), not the management
// API (which lags).
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { attachConsumer, purgeQueues, readyCount, seedMessages, startApp, testProfile, type TestApp } from './harness.js';

const checkoutPath = (queue: string) => `/api/profiles/local/vhosts/%2F/queues/${encodeURIComponent(queue)}/checkouts`;
const queues = ['orders.dlq', 'payments.dlq'];

describe('live consumers', () => {
  let app: TestApp;
  const open: string[] = [];
  const detach: Array<() => Promise<void>> = [];

  async function startCheckout(queue: string, body?: unknown) {
    const res = await app.post(checkoutPath(queue), body);
    if (res.status === 201) open.push(res.body.checkout.id);
    return res;
  }

  beforeAll(async () => {
    app = await startApp({ profiles: [testProfile({ name: 'local' })] });
  });
  afterEach(async () => {
    while (open.length) await app.delete(`/api/checkouts/${open.pop()}`);
    while (detach.length) await detach.pop()!();
    await purgeQueues('/', queues);
  });
  afterAll(async () => {
    await app?.close();
  });

  it.each(queues)('refuses a Checkout of %s while consumers read it, with their count, and takes nothing', async (queue) => {
    await seedMessages('/', queue, 4);
    detach.push(await attachConsumer('/', queue), await attachConsumer('/', queue));

    const res = await startCheckout(queue);

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('queue_has_consumers');
    expect(res.body.error.consumers).toBe(2);
    expect(res.body.error.message).toMatch(/2 consumers are reading queue/);
    // Each consumer holds one (prefetch 1); the Checkout took none of the rest.
    expect(await readyCount('/', queue)).toBe(2);
    // The refused start freed the queue and the Operator.
    expect((await app.get('/api/session')).body.checkoutId).toBeNull();
  });

  it.each(queues)('checks out %s despite a live consumer when the Operator overrides the warning', async (queue) => {
    await seedMessages('/', queue, 3);
    detach.push(await attachConsumer('/', queue));

    const res = await startCheckout(queue, { overrideConsumers: true });

    expect(res.status).toBe(201);
    // The live consumer holds one Message (prefetch 1); the Checkout takes the ready ones.
    expect(res.body.checkout.heldCount).toBe(2);
    expect(await readyCount('/', queue)).toBe(0);
  });

  it('rejects an override that is not a boolean', async () => {
    const res = await startCheckout('orders.dlq', { overrideConsumers: 'yes' });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('invalid_request');
  });
});
