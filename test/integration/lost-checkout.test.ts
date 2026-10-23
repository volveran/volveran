// A Checkout that ends without Volverán ending it (a Lost Checkout): the
// process killed, its connection dropped, or its channel closed by the
// Checkout's quorum x-consumer-timeout backstop (a channel close once the
// consumer is cancelled, ADR 0006). In every case the broker returns the
// Messages and releases the lock queue, and the app reports the Checkout as
// lost.
import { spawn, type ChildProcess } from 'node:child_process';
import { rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import * as amqp from 'amqplib';
import { stringify } from 'yaml';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { repoRoot } from '../../scripts/test-broker-env.mjs';
import {
  brokerUsers,
  checkoutConnectionNames,
  closeConnection,
  eventually,
  makeTempDir,
  purgeQueues,
  readyCount,
  seedMessages,
  startApp,
  testProfile,
  uniqueName,
  withChannel,
  type TestApp,
} from './harness.js';

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
    expect(await readyCount('/', queue)).toBe(3);
    // The broker deleted the lock queue with the connection, and the Operator may start again.
    expect((await app.get('/api/session')).body.checkoutId).toBeNull();
    const again = await app.post(checkoutPath(queue));
    expect(again.status).toBe(201);
    await app.delete(`/api/checkouts/${again.body.checkout.id}`);
  });

  describe("when the broker's x-consumer-timeout backstop fires on a quorum queue (a channel close, since the Checkout cancelled its consumer)", () => {
    let queue: string;
    let backstopApp: TestApp;
    /** Holds the app's own time-limit end back, so the broker's backstop fires first. */
    let releaseTimeLimit: () => void = () => {};
    beforeAll(async () => {
      queue = uniqueName('lost-checkout');
      // A queue-level timeout of an hour: only the Checkout's own consumer argument can fire within the test.
      await withChannel('/', (ch) =>
        ch.assertQueue(queue, { arguments: { 'x-queue-type': 'quorum', 'x-consumer-timeout': 3_600_000 } }),
      );
      backstopApp = await startApp({
        profiles: [testProfile({ name: 'local' })],
        checkoutTiming: { timeLimitMs: 1_000, consumerTimeoutMarginMs: 1_000, heartbeatWindowMs: 60_000 },
        checkoutTestHooks: {
          beforeTimeLimitEnd: () => new Promise<void>((resolve) => (releaseTimeLimit = resolve)),
        },
      });
    });
    afterAll(async () => {
      releaseTimeLimit();
      await backstopApp?.close();
      await withChannel('/', (ch) => ch.deleteQueue(queue));
    });

    it('reports the Checkout lost, returns the Messages in order and frees the queue', async () => {
      await seedMessages('/', queue, 3);
      const { checkout } = (await backstopApp.post(checkoutPath(queue))).body;
      expect(checkout.heldCount).toBe(3);

      const lost = await eventually(async () => {
        const res = await backstopApp.get(`/api/checkouts/${checkout.id}`);
        expect(res.body.checkout.status).toBe('lost');
        return res.body.checkout;
      }, 20_000);
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
  });

  describe('when the process is killed', () => {
    let dir: string;
    let child: ChildProcess | undefined;
    afterEach(async () => {
      child?.kill('SIGKILL');
      if (dir) await rm(dir, { recursive: true, force: true });
    });

    /** Runs the real server entry point (src/server/main.ts) as a child process; resolves with its URL. */
    async function spawnServer(): Promise<string> {
      dir = await makeTempDir('killed');
      const profilesFile = path.join(dir, 'profiles.yaml');
      await writeFile(profilesFile, stringify({ profiles: [testProfile({ name: 'local', passwordEnv: 'LOCAL_PW' })] }));
      child = spawn(process.execPath, ['--import', 'tsx', 'src/server/main.ts'], {
        cwd: repoRoot,
        env: {
          PATH: process.env.PATH,
          VOLVERAN_PROFILES_FILE: profilesFile,
          VOLVERAN_PORT: '0',
          VOLVERAN_OPERATOR: 'killed-operator',
          LOCAL_PW: brokerUsers.admin.password,
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      return new Promise((resolve, reject) => {
        let out = '';
        child!.stdout!.on('data', (chunk: Buffer) => {
          out += chunk.toString();
          const url = /listening on (http:\/\/\S+)/.exec(out)?.[1];
          if (url) resolve(url);
        });
        child!.stderr!.on('data', (chunk: Buffer) => (out += chunk.toString()));
        child!.on('exit', (code) => reject(new Error(`server exited with ${code}: ${out}`)));
      });
    }

    it.each(queues)('returns every Message to %s (quorum: x-delivery-count +1, as documented)', async (queue) => {
      await seedMessages('/', queue, 3);
      const before = await readyMessages(queue);
      const url = await spawnServer();
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
      const again = await app.post(checkoutPath(queue));
      expect(again.status).toBe(201);
      await app.delete(`/api/checkouts/${again.body.checkout.id}`);
    });
  });
});
