// Keep on a quorum queue through the HTTP API against the test broker: ending
// a Checkout costs no Delivery Budget (ADR 0006), and waiting for the queue to
// take its Messages back has a time limit. The broker is checked independently
// over AMQP.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { connect, drain, purgeQueues, seedMessages, startApp, testProfile, waitForReady, withChannel, type TestApp } from './harness.js';

const queue = 'payments.dlq';
const checkoutPath = `/api/profiles/local/vhosts/${encodeURIComponent('/')}/queues/${encodeURIComponent(queue)}/checkouts`;

/** Takes every ready Message of the queue for good: their ids in order, and how many have a delivery counted. */
async function takeAll(): Promise<{ ids: string[]; counted: number }> {
  return withChannel('/', async (ch) => {
    const taken = await drain(ch, queue);
    return {
      ids: taken.map((m) => String(m.properties.messageId)),
      counted: taken.filter((m) => m.properties.headers?.['x-delivery-count'] !== undefined).length,
    };
  });
}

const idsOf = (from: number, count: number) => Array.from({ length: count }, (_, i) => `${queue}-${from + i}`);

describe('Keep on a quorum queue', () => {
  beforeEach(() => purgeQueues('/', [queue]));
  // Keep returns Messages to a queue the rest of the suite shares.
  afterAll(() => purgeQueues('/', [queue]));

  describe('with the default wait', () => {
    let app: TestApp;
    beforeAll(async () => {
      app = await startApp({ profiles: [testProfile({ name: 'local' })] });
    });
    afterAll(() => app.close());

    it('adds no delivery count when a Checkout of 1,000 Messages ends', async () => {
      await seedMessages('/', queue, 1_000);
      const { checkout } = (await app.post(checkoutPath)).body;
      expect(checkout.heldCount).toBe(1_000);

      expect((await app.delete(`/api/checkouts/${checkout.id}`)).status).toBe(200);

      await waitForReady('/', queue, 1_000);
      const { ids, counted } = await takeAll();
      expect(counted).toBe(0);
      // Every Message, but not in order: at this size a quorum queue does not keep the return order (noted on #134).
      expect([...ids].sort()).toEqual(idsOf(0, 1_000).sort());
    }, 180_000);

    it('counts the Messages it left in the queue when it waits for those it returns', async () => {
      const limited = await startApp({ profiles: [testProfile({ name: 'local' })], checkoutLimits: { maxMessages: 200 } });
      try {
        await seedMessages('/', queue, 300);
        const { checkout } = (await limited.post(checkoutPath)).body;
        expect(checkout.heldCount).toBe(200);

        await limited.delete(`/api/checkouts/${checkout.id}`);

        await waitForReady('/', queue, 300);
        expect((await takeAll()).counted).toBe(0);
      } finally {
        await limited.close();
      }
    }, 90_000);
  });

  it('stops waiting at the time limit and logs it when another consumer takes the Messages back', async () => {
    const logs: Array<Record<string, any>> = [];
    const app = await startApp({ profiles: [testProfile({ name: 'local' })], logs, checkoutTestHooks: { returnWaitMs: 500 } });
    const other = await connect();
    try {
      await seedMessages('/', queue, 5);
      const { checkout } = (await app.post(checkoutPath)).body;
      // Everything returned goes to this consumer, so the ready count never gets there.
      const taken: unknown[] = [];
      const ch = await other.createChannel();
      await ch.consume(queue, (m) => taken.push(m), { noAck: true });

      const ended = await app.delete(`/api/checkouts/${checkout.id}`);

      expect(ended.status).toBe(200);
      expect(ended.body.checkout).toMatchObject({ status: 'ended', heldCount: 0 });
      const warning = logs.find((l) => /stopped waiting/.test(l.msg ?? ''));
      expect(warning).toMatchObject({ level: 40, checkoutId: checkout.id, queue, returned: 5, waitedMs: 500 });
    } finally {
      await other.close();
      await app.close();
    }
  });

  it('logs nothing about the wait when the Messages come back in time', async () => {
    const logs: Array<Record<string, any>> = [];
    const app = await startApp({ profiles: [testProfile({ name: 'local' })], logs });
    try {
      await seedMessages('/', queue, 5);
      const { checkout } = (await app.post(checkoutPath)).body;
      await app.delete(`/api/checkouts/${checkout.id}`);
      expect(logs.filter((l) => /stopped waiting/.test(l.msg ?? ''))).toEqual([]);
    } finally {
      await app.close();
    }
  });
});
