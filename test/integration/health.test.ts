// Health endpoints for Kubernetes probes: /healthz (the process serves HTTP)
// and /readyz (startup has finished). Both sit outside /api/, answer without
// a session, never depend on a broker and reveal nothing about Broker
// Profiles, queues or Operators.
import type { ChildProcess } from 'node:child_process';
import { rm } from 'node:fs/promises';
import { connect, type Socket } from 'node:net';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { product } from '../../src/shared/product.js';
import {
  brokerUsers,
  closedPort,
  makeTempDir,
  purgeQueues,
  seedMessages,
  spawnServer,
  startApp,
  testOperator,
  testProfile,
  type TestApp,
} from './harness.js';
import { teamModeEnv, TestBrowser } from './oidc-provider.js';

const probes = ['/healthz', '/readyz'];

describe('health endpoints in Team Mode', () => {
  let app: TestApp;
  let baseUrl: string;
  beforeAll(async () => {
    const port = await closedPort();
    baseUrl = `http://127.0.0.1:${port}`;
    const deadPort = await closedPort();
    app = await startApp({
      profiles: [
        testProfile({ name: 'dev' }),
        testProfile({
          name: 'unreachable',
          managementUrl: `http://127.0.0.1:${deadPort}`,
          amqpUrl: `amqp://127.0.0.1:${deadPort}`,
        }),
      ],
      port,
      env: teamModeEnv(baseUrl),
    });
  });
  afterAll(async () => {
    await app?.close();
  });

  it.each(probes)('answers %s with 200 without a session', async (path) => {
    const res = await new TestBrowser(baseUrl).get(path);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'ok' });
  });

  it('still refuses /api/ routes without a session', async () => {
    expect((await new TestBrowser(baseUrl).get('/api/profiles')).status).toBe(401);
  });
});

describe('health endpoints in Solo Mode', () => {
  let app: TestApp | undefined;
  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  it.each(probes)('answers %s with 200 on loopback', async (path) => {
    app = await startApp({ profiles: [testProfile({ name: 'dev' })] });
    const res = await app.get(path);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'ok' });
  });

  it('stays ready when a Broker Profile points at an unreachable broker', async () => {
    const deadPort = await closedPort();
    app = await startApp({
      profiles: [
        testProfile({
          name: 'unreachable',
          managementUrl: `http://127.0.0.1:${deadPort}`,
          amqpUrl: `amqp://127.0.0.1:${deadPort}`,
        }),
      ],
    });
    expect((await app.get('/api/profiles/unreachable/vhosts')).status).toBe(502);
    expect((await app.get('/readyz')).status).toBe(200);
  });

  it.each(probes)('reveals no profile, queue, Operator or version data in %s', async (path) => {
    app = await startApp({ profiles: [testProfile({ name: 'secret-profile' })] });
    const text = await (await fetch(app.baseUrl + path)).text();
    for (const leak of ['secret-profile', 'dlq', testOperator, product.version]) expect(text).not.toContain(leak);
  });
});

describe('/readyz during shutdown', () => {
  const QUEUE = 'orders.dlq';
  afterEach(async () => {
    await purgeQueues('/', [QUEUE]);
  });

  /** Raw HTTP/1.1 on one socket, so a request can be sent on a connection that shutdown has not closed yet. */
  function rawClient(baseUrl: string) {
    const url = new URL(baseUrl);
    const socket: Socket = connect(Number(url.port), url.hostname);
    let received = '';
    socket.on('data', (chunk: Buffer) => (received += chunk.toString()));
    return {
      send: (request: string) => socket.write(request),
      received: () => received,
      destroy: () => socket.destroy(),
    };
  }

  it('answers 503 once shutdown has begun', async () => {
    // A Checkout start that waits at its lock keeps one connection busy, so
    // shutdown cannot close it while the probe is sent on it.
    let locked!: () => void;
    const isLocked = new Promise<void>((resolve) => (locked = resolve));
    let release!: () => void;
    const app = await startApp({
      profiles: [testProfile({ name: 'local' })],
      checkoutTestHooks: {
        afterLock: () => {
          locked();
          return new Promise<void>((resolve) => (release = resolve));
        },
      },
    });
    await seedMessages('/', QUEUE, 1);
    const client = rawClient(app.baseUrl);
    const statuses = () => [...client.received().matchAll(/HTTP\/1\.1 (\d{3}) /g)].map((m) => Number(m[1]));
    let closing: Promise<void> | undefined;
    try {
      client.send(
        `POST /api/profiles/local/vhosts/%2F/queues/${QUEUE}/checkouts HTTP/1.1\r\n` +
          'Host: volveran\r\nContent-Type: application/json\r\nContent-Length: 2\r\n\r\n{}',
      );
      await isLocked;
      closing = app.close();
      // Shutdown has begun once the server stops accepting connections.
      await expect
        .poll(() => fetch(app.baseUrl + '/healthz').then(() => 'accepted', () => 'refused'), { timeout: 5_000 })
        .toBe('refused');
      client.send('GET /readyz HTTP/1.1\r\nHost: volveran\r\n\r\n');
      release();

      await expect.poll(statuses, { timeout: 5_000 }).toEqual([201, 503]);
    } finally {
      client.destroy();
      release?.();
      await (closing ?? app.close());
    }
  });
});

describe('the request log', () => {
  let dir: string | undefined;
  let child: ChildProcess | undefined;
  afterEach(async () => {
    child?.kill('SIGKILL');
    child = undefined;
    if (dir) await rm(dir, { recursive: true, force: true });
    dir = undefined;
  });

  it('leaves probe requests out', async () => {
    dir = await makeTempDir('health-log');
    const spawned = await spawnServer({
      script: 'src/server/main.ts',
      dir,
      profiles: [testProfile({ name: 'dev', passwordEnv: 'DEV_PW' })],
      env: { VOLVERAN_OPERATOR: 'log-operator', DEV_PW: brokerUsers.admin.password },
    });
    child = spawned.child;
    let log = '';
    child.stdout!.on('data', (chunk: Buffer) => (log += chunk.toString()));

    for (const path of probes) expect((await fetch(spawned.url + path)).status).toBe(200);
    // An ordinary request is logged, so its line marks that the probes' lines would have arrived.
    await fetch(spawned.url + '/api/session');
    await expect.poll(() => log, { timeout: 5_000 }).toContain('/api/session');

    expect(log).not.toContain('/healthz');
    expect(log).not.toContain('/readyz');
  });
});
