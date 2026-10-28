// Talks to this checkout's test broker (test/broker/docker-compose.yml) as
// volveran-admin, with raw amqplib and the management HTTP API. Shared by the
// broker-facts and integration suites; it must not import src/, so the
// broker-facts suite checks RabbitMQ and nothing of Volverán.
//
// Ports come from VOLVERAN_TEST_AMQP_PORT / VOLVERAN_TEST_MGMT_PORT (set by
// scripts/test-broker.mjs run), or are asked from docker compose when a test
// runner is started by hand against `npm run broker:up`.
import { randomBytes } from 'node:crypto';
import * as amqp from 'amqplib';
import { publishedPorts, repoRoot, testBrokerSettings } from '../../scripts/test-broker-env.mjs';

function resolvePorts(): { amqpPort: number; mgmtPort: number } {
  const settings = testBrokerSettings(repoRoot, process.env);
  const ports =
    settings.amqpPort && settings.mgmtPort
      ? { amqpPort: settings.amqpPort, mgmtPort: settings.mgmtPort }
      : publishedPorts(settings.project);
  return { amqpPort: Number(ports.amqpPort), mgmtPort: Number(ports.mgmtPort) };
}

let ports: { amqpPort: number; mgmtPort: number } | undefined;
const brokerPorts = () => (ports ??= resolvePorts());

export const testBroker = {
  host: '127.0.0.1',
  get amqpPort() {
    return brokerPorts().amqpPort;
  },
  get mgmtPort() {
    return brokerPorts().mgmtPort;
  },
  get managementUrl() {
    return `http://${this.host}:${this.mgmtPort}`;
  },
  get amqpUrl() {
    return `amqp://${this.host}:${this.amqpPort}`;
  },
  /** The global `consumer_timeout` in test/broker/rabbitmq.conf. */
  consumerTimeoutMs: 15_000,
};

/** Users defined in test/broker/definitions.json. */
export const brokerUsers = {
  /** administrator, full permissions on "/" and "other". */
  admin: { username: 'volveran-admin', password: 'volveran-admin-pass' },
  /** management tag, permissions on "other" only. */
  noPerm: { username: 'volveran-noperm', password: 'volveran-noperm-pass' },
  /** no management tag, permissions on "/". */
  noMgmt: { username: 'volveran-nomgmt', password: 'volveran-nomgmt-pass' },
  /** management tag, read and write on "/" but no configure permission (cannot declare a Checkout lock queue `volveran.checkout.*`). */
  noLock: { username: 'volveran-nolock', password: 'volveran-nolock-pass' },
} as const;

/**
 * Opens a connection as volveran-admin. Connection and channel errors the
 * broker raises on purpose in tests must not crash the runner, so errors are
 * swallowed here; tests observe them through promises and `close` events.
 */
export async function connect(vhost = '/'): Promise<amqp.ChannelModel> {
  const conn = await amqp.connect({
    hostname: testBroker.host,
    port: testBroker.amqpPort,
    username: brokerUsers.admin.username,
    password: brokerUsers.admin.password,
    vhost,
  });
  conn.on('error', () => {});
  return conn;
}

/** A channel whose `error` events (a channel closed by the broker) do not throw. */
export async function openChannel(conn: amqp.ChannelModel): Promise<amqp.Channel> {
  const ch = await conn.createChannel();
  ch.on('error', () => {});
  return ch;
}

/** A confirm channel whose `error` events do not throw. */
export async function openConfirmChannel(conn: amqp.ChannelModel): Promise<amqp.ConfirmChannel> {
  const ch = await conn.createConfirmChannel();
  ch.on('error', () => {});
  return ch;
}

export async function withChannel<T>(vhost: string, fn: (ch: amqp.ConfirmChannel) => Promise<T>): Promise<T> {
  const conn = await connect(vhost);
  try {
    return await fn(await openConfirmChannel(conn));
  } finally {
    await conn.close().catch(() => {});
  }
}

/** A queue name no other test uses, for queues a test declares itself. */
export function uniqueName(prefix: string): string {
  return `facts.${prefix}.${randomBytes(4).toString('hex')}`;
}

export async function purgeQueues(vhost: string, queues: string[]): Promise<void> {
  await withChannel(vhost, async (ch) => {
    for (const q of queues) await ch.purgeQueue(q);
  });
}

/** Publishes `count` messages straight into `queue` via the default exchange. */
export async function seedMessages(vhost: string, queue: string, count: number): Promise<void> {
  await withChannel(vhost, async (ch) => {
    for (let i = 0; i < count; i++) {
      ch.sendToQueue(queue, Buffer.from(JSON.stringify({ n: i })), {
        contentType: 'application/json',
        messageId: `${queue}-${i}`,
        persistent: true,
      });
    }
    await ch.waitForConfirms();
  });
}

/**
 * Origin exchange → work queue pairs in test/broker/definitions.json. Each
 * work queue dead-letters through a fanout exchange into all of `dlqs`.
 */
export const deadLetterRoutes = {
  classic: {
    vhost: '/',
    exchange: 'orders',
    workQueue: 'orders.work',
    dlq: 'orders.dlq',
    /** classic `orders.dlq`; quorum `orders.dlq.quorum` (default delivery-limit, no dead-letter exchange); quorum `orders.dlq.quorum-dlx` (dead-letters into `orders.parked`). */
    dlqs: ['orders.dlq', 'orders.dlq.quorum', 'orders.dlq.quorum-dlx'],
    routingKey: 'orders.created',
  },
  quorum: {
    vhost: '/',
    exchange: 'payments',
    workQueue: 'payments.work',
    dlq: 'payments.dlq',
    /** quorum `payments.dlq` (`x-delivery-limit` 5, no dead-letter exchange); classic `payments.dlq.classic`. */
    dlqs: ['payments.dlq', 'payments.dlq.classic'],
    routingKey: 'payments.captured',
  },
} as const;

/** Every queue in vhost "/" of test/broker/definitions.json that holds Messages in tests. */
export const fixtureQueues = [
  'orders.work',
  'orders.dlq',
  'orders.dlq.quorum',
  'orders.dlq.quorum-dlx',
  'orders.parked',
  'payments.work',
  'payments.dlq',
  'payments.dlq.classic',
  'triage.manual',
];

export interface SeedMessage {
  body: string | Buffer;
  routingKey?: string;
  options?: amqp.Options.Publish;
}

/**
 * Publishes Messages to the origin exchange of `route`, then consumes and
 * rejects them from its work queue so the broker dead-letters them into the
 * DLQs with a real `x-death` header. Resolves once all have been rejected.
 */
export async function deadLetter(
  route: (typeof deadLetterRoutes)[keyof typeof deadLetterRoutes],
  messages: SeedMessage[],
): Promise<void> {
  await withChannel(route.vhost, async (ch) => {
    for (const m of messages) {
      ch.publish(route.exchange, m.routingKey ?? route.routingKey, Buffer.from(m.body), {
        persistent: true,
        ...m.options,
      });
    }
    await ch.waitForConfirms();

    let rejected = 0;
    let consumerTag: string | undefined;
    await new Promise<void>((resolve, reject) => {
      ch.consume(route.workQueue, (msg) => {
        if (!msg) return reject(new Error(`consumer on ${route.workQueue} was cancelled`));
        ch.nack(msg, false, false);
        if (++rejected === messages.length) resolve();
      })
        .then((ok) => (consumerTag = ok.consumerTag))
        .catch(reject);
    });
    // A round trip after the nacks so the broker has processed them before
    // the connection closes.
    if (consumerTag) await ch.cancel(consumerTag);
  });
}

/** Opens a consumer on `queue` that never acks; returns a function closing it. */
export async function attachConsumer(vhost: string, queue: string): Promise<() => Promise<void>> {
  const conn = await connect(vhost);
  const ch = await openChannel(conn);
  await ch.prefetch(1);
  await ch.consume(queue, () => {});
  return async () => {
    await conn.close();
  };
}

/** Ready Messages in `queue` (exact, via AMQP passive declare). */
export async function readyCount(vhost: string, queue: string): Promise<number> {
  return withChannel(vhost, async (ch) => (await ch.checkQueue(queue)).messageCount);
}

/**
 * Waits until `queue` has exactly `count` ready Messages. A quorum queue
 * takes back Messages nacked or left unacknowledged by a closed channel or
 * connection through its Raft log, so they count as ready shortly after,
 * not at once. A passive declare, so waiting never changes the queue.
 */
export async function waitForReady(vhost: string, queue: string, count: number): Promise<void> {
  await eventually(async () => {
    const ready = await readyCount(vhost, queue);
    if (ready !== count) throw new Error(`${queue} has ${ready} ready Messages, expected ${count}`);
  });
}

/**
 * Takes every ready Message in `queue`, returns their message ids and puts
 * them all back (basic.nack requeue, so no delivery attempt is used).
 */
export async function readyMessageIds(vhost: string, queue: string): Promise<string[]> {
  return withChannel(vhost, async (ch) => {
    const taken: amqp.GetMessage[] = [];
    for (;;) {
      const m = await ch.get(queue, { noAck: false });
      if (!m) break;
      taken.push(m);
    }
    for (const m of taken) ch.nack(m, false, true);
    await ch.checkQueue(queue); // round trip so the nacks are processed first
    return taken.map((m) => String(m.properties.messageId));
  });
}

/** Takes every ready Message in `queue` with auto-ack, oldest first. */
export async function drain(ch: amqp.Channel, queue: string): Promise<amqp.GetMessage[]> {
  const out: amqp.GetMessage[] = [];
  for (;;) {
    const m = await ch.get(queue, { noAck: true });
    if (!m) return out;
    out.push(m);
  }
}

const adminAuth = () =>
  'Basic ' + Buffer.from(`${brokerUsers.admin.username}:${brokerUsers.admin.password}`).toString('base64');

/** A management API call as volveran-admin; `path` starts after `/api`. */
export async function management(
  path: string,
  init: { method?: string; body?: unknown; headers?: Record<string, string> } = {},
): Promise<{ status: number; body: any }> {
  const res = await fetch(`${testBroker.managementUrl}/api${path}`, {
    method: init.method ?? 'GET',
    headers: {
      authorization: adminAuth(),
      ...(init.body === undefined ? {} : { 'content-type': 'application/json' }),
      ...init.headers,
    },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
  const text = await res.text();
  let body: unknown = text;
  try {
    body = text ? JSON.parse(text) : undefined;
  } catch {
    // not JSON: keep the text
  }
  return { status: res.status, body };
}

/** Management API path segment for a vhost. */
export const vhostPath = (vhost: string) => encodeURIComponent(vhost);

/** Force-closes a connection through the management API. */
export async function closeConnection(name: string): Promise<void> {
  const res = await management(`/connections/${encodeURIComponent(name)}`, {
    method: 'DELETE',
    headers: { 'x-reason': 'test closes the connection' },
  });
  if (res.status !== 204) throw new Error(`closing connection ${name}: HTTP ${res.status}`);
}

/** Polls `fn` until it returns without throwing, or rethrows after `timeoutMs`. */
export async function eventually<T>(fn: () => Promise<T>, timeoutMs = 15_000, intervalMs = 250): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      return await fn();
    } catch (err) {
      if (Date.now() > deadline) throw err;
      await sleep(intervalMs);
    }
  }
}

export const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
