// A Checkout that ends without Volverán ending it (a Lost Checkout): the
// process killed, its connection dropped, or its channel closed by the
// Checkout's quorum x-consumer-timeout backstop (a channel close once the
// consumer is cancelled, ADR 0006). In every case the broker returns the
// Messages and releases the lock queue, and the app reports the Checkout as
// lost.
import type { ChildProcess } from 'node:child_process';
import { rm } from 'node:fs/promises';
import * as amqp from 'amqplib';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  brokerUsers,
  checkoutConnectionNames,
  closeConnection,
  eventually,
  makeTempDir,
  management,
  purgeQueues,
  readyCount,
  seedMessages,
  spawnServer,
  startApp,
  testBroker,
  testProfile,
  uniqueName,
  waitForReady,
  withChannel,
  type TestApp,
} from './harness.js';
import { startTcpProxy } from '../support/tcp-proxy.js';

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

describe('Lost Checkout', () => {
  let app: TestApp;
  const queues = ['orders.dlq', 'payments.dlq'];

  beforeAll(async () => {
    app = await startApp({ profiles: [testProfile({ name: 'local' })] });
  });
  afterEach(async () => {
    await purgeQueues('/', queues);
  });
  afterAll(async () => {
    await app?.close();
  });

  it.each(queues)("returns every Message to %s and frees the queue when the Checkout's connection drops", async (queue) => {
    await seedMessages('/', queue, 3);
    const { checkout } = (await app.post(checkoutPath(queue))).body;
    const names = await eventually(async () => {
      const found = await checkoutConnectionNames(queue);
      expect(found).toHaveLength(1);
      return found;
    });

    await closeConnection(names[0]!);

    const lost = await eventually(async () => {
      const res = await app.get(`/api/checkouts/${checkout.id}`);
      expect(res.body.checkout.status).toBe('lost');
      return res.body.checkout;
    });
    expect(lost.lostReason).toMatch(/connection to the broker was closed.*returned every Message/);
    expect(lost.messages).toEqual([]);
    await waitForReady('/', queue, 3);
    // The broker deleted the lock queue with the connection, and the Operator may start again.
    expect((await app.get('/api/session')).body.checkoutId).toBeNull();
    const again = await app.post(checkoutPath(queue));
    expect(again.status, JSON.stringify(again.body)).toBe(201);
    await app.delete(`/api/checkouts/${again.body.checkout.id}`);
  });

  describe("when the broker's x-consumer-timeout backstop fires on a quorum queue (a channel close, since the Checkout cancelled its consumer)", () => {
    let queue: string;
    let backstopApp: TestApp;
    /** Holds the app's own time-limit end back, so the broker's backstop fires first. */
    let releaseTimeLimit: () => void = () => {};
    const timing = { timeLimitMs: 1_000, consumerTimeoutMarginMs: 1_000, heartbeatWindowMs: 60_000 };
    /** The x-consumer-timeout of the Checkout consumer: time limit + margin. */
    const backstopMs = timing.timeLimitMs + timing.consumerTimeoutMarginMs;
    beforeAll(async () => {
      queue = uniqueName('lost-checkout');
      // A queue-level timeout of an hour: only the Checkout's own consumer argument can fire within the test.
      await withChannel('/', (ch) =>
        ch.assertQueue(queue, { arguments: { 'x-queue-type': 'quorum', 'x-consumer-timeout': 3_600_000 } }),
      );
      backstopApp = await startApp({
        profiles: [testProfile({ name: 'local' })],
        checkoutTiming: timing,
        checkoutTestHooks: {
          beforeTimeLimitEnd: () => new Promise<void>((resolve) => (releaseTimeLimit = resolve)),
        },
      });
    });
    afterAll(async () => {
      releaseTimeLimit();
      await backstopApp?.close();
      await management(nudgePolicyPath(), { method: 'DELETE' });
      await withChannel('/', (ch) => ch.deleteQueue(queue));
    });

    const nudgePolicyPath = () => `/policies/%2F/${encodeURIComponent(queue)}`;

    /**
     * Polls the Checkout until it is lost. A quorum queue checks consumer
     * timeouts on a single timer that it only re-arms after applying a
     * command (rabbit_fifo's evaluate_consumer_timeout, re-armed only for an
     * earlier deadline than the last one). Nothing else touches this queue
     * during the Checkout, and in CI that timer has fired once without
     * expiring anything and never been re-armed: still active after 20 s,
     * although the backstop fires within a second of its deadline otherwise.
     * So once the deadline is well past, a policy change (a command on the
     * queue; `max-length` far above what the test holds) makes the queue
     * check again. It is still the broker's timeout that closes the channel.
     */
    async function untilLost(checkoutId: string, consumedAt: number) {
      let nudges = 0;
      return eventually(async () => {
        const { checkout } = (await backstopApp.get(`/api/checkouts/${checkoutId}`)).body;
        if (checkout.status === 'active' && Date.now() > consumedAt + backstopMs + (nudges + 1) * 3_000) {
          nudges++;
          const put = await management(nudgePolicyPath(), {
            method: 'PUT',
            body: { pattern: `^${queue.replace(/\./g, '\\.')}$`, definition: { 'max-length': 1_000_000 + nudges }, 'apply-to': 'queues' },
          });
          expect(put.status).toBeLessThan(300);
        }
        expect(checkout.status).toBe('lost');
        return checkout;
      }, 20_000);
    }

    it('reports the Checkout lost, returns the Messages in order and frees the queue', async () => {
      await seedMessages('/', queue, 3);
      const consumedAt = Date.now();
      const { checkout } = (await backstopApp.post(checkoutPath(queue))).body;
      expect(checkout.heldCount).toBe(3);

      const lost = await untilLost(checkout.id, consumedAt);
      releaseTimeLimit();

      expect(lost.lostReason).toMatch(/closed the channel.*back in the queue/);
      expect(lost.endReason).toBeNull();
      expect((await readyMessages(queue)).map((m) => m.id)).toEqual([0, 1, 2].map((i) => `${queue}-${i}`));
      // Neither a heartbeat nor ending it revives or ends a Lost Checkout.
      expect((await backstopApp.post(`/api/checkouts/${checkout.id}/heartbeat`)).body.checkout.status).toBe('lost');
      expect((await backstopApp.delete(`/api/checkouts/${checkout.id}`)).body.checkout.status).toBe('lost');
      const again = await backstopApp.post(checkoutPath(queue));
      expect(again.status).toBe(201);
      await backstopApp.delete(`/api/checkouts/${again.body.checkout.id}`);
    });

    it('Apply returns an error after the quorum backstop fires', async () => {
      await withChannel('/', (ch) => ch.purgeQueue(queue));
      await seedMessages('/', queue, 2);
      const consumedAt = Date.now();
      const { checkout } = (await backstopApp.post(checkoutPath(queue))).body;
      const decided = await backstopApp.post(`/api/checkouts/${checkout.id}/decisions`, {
        handles: [checkout.messages[0].handle],
        decision: { kind: 'discard', reason: 'poison' },
      });
      expect(decided.status).toBe(200);
      await untilLost(checkout.id, consumedAt);
      releaseTimeLimit();

      const applied = await backstopApp.post(`/api/checkouts/${checkout.id}/apply`, { confirm: true });

      expect([applied.status, applied.body.error.code]).toEqual([409, 'checkout_not_active']);
      expect(applied.body.error.message).toMatch(/was lost: The broker closed the channel/);
      expect((await readyMessages(queue)).map((m) => m.id)).toEqual([0, 1].map((i) => `${queue}-${i}`));
      expect((await backstopApp.get(`/api/audit-entries?checkoutId=${checkout.id}`)).body.entries).toEqual([]);
    });
  });

  describe('when the host or network goes silent, the socket still open', () => {
    it('returns every Message and frees the queue within the heartbeats, far sooner than at the broker default of about three minutes', async () => {
      const queue = 'orders.dlq';
      await seedMessages('/', queue, 3);
      const proxy = await startTcpProxy(testBroker.amqpPort);
      const silent = await startApp({ profiles: [testProfile({ name: 'local', amqpUrl: `amqp://127.0.0.1:${proxy.port}` })] });
      try {
        const { checkout } = (await silent.post(checkoutPath(queue))).body;
        expect(checkout.heldCount).toBe(3);

        proxy.silence();

        await eventually(async () => expect(await readyCount('/', queue)).toBe(3), 30_000);
        // This side's own heartbeat check sees it too, so the Operator is told.
        await eventually(async () => {
          expect((await silent.get(`/api/checkouts/${checkout.id}`)).body.checkout.status).toBe('lost');
        }, 30_000);
      } finally {
        await silent.close();
        await proxy.close();
      }
    }, 90_000);
  });

  describe('when the process is killed', () => {
    let dir: string;
    let child: ChildProcess | undefined;
    afterEach(async () => {
      child?.kill('SIGKILL');
      if (dir) await rm(dir, { recursive: true, force: true });
    });

    /** Runs the real server entry point (src/server/main.ts) as a child process, with a temporary data directory; resolves with its URL. */
    async function startChild(): Promise<string> {
      dir = await makeTempDir('killed');
      const spawned = await spawnServer({
        script: 'src/server/main.ts',
        dir,
        profiles: [testProfile({ name: 'local', passwordEnv: 'LOCAL_PW' })],
        env: { VOLVERAN_OPERATOR: 'killed-operator', LOCAL_PW: brokerUsers.admin.password },
      });
      child = spawned.child;
      return spawned.url;
    }

    it.each(queues)('returns every Message to %s (quorum: x-delivery-count +1, as documented)', async (queue) => {
      await seedMessages('/', queue, 3);
      const before = await readyMessages(queue);
      const url = await startChild();
      const started = await fetch(url + checkoutPath(queue), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      });
      expect(started.status).toBe(201);
      expect(await readyCount('/', queue)).toBe(0);

      child!.kill('SIGKILL');

      await eventually(async () => expect(await readyCount('/', queue)).toBe(3));
      const after = await readyMessages(queue);
      expect(after.map((m) => m.id).sort()).toEqual(before.map((m) => m.id).sort());
      const expected = queue === 'payments.dlq' ? 1 : undefined;
      expect(after.map((m) => m.deliveryCount)).toEqual([expected, expected, expected]);
      // The broker released the lock with the connection.
      // Only once it has noticed the close and deleted the lock queue, which comes after the Messages' return.
      const again = await eventually(async () => {
        const res = await app.post(checkoutPath(queue));
        expect(res.status).toBe(201);
        return res;
      });
      await app.delete(`/api/checkouts/${again.body.checkout.id}`);
      // Starting a child process (tsx) and waiting for the broker to notice it died take longer than the default.
    }, 60_000);
  });
});
