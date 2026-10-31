// docs/rabbitmq-behaviour.md, "Dead connections". The silent tests wait out
// real heartbeats, so they run concurrently; each uses its own queues.
import net from 'node:net';
import * as amqp from 'amqplib';
import { describe, expect, it } from 'vitest';
import { brokerUsers, sleep, testBroker, uniqueName } from '../broker/client.js';
import { counts, hold, next, type QueueType, queueTypes, refusal, type Scratch, scratchFor, take } from './support.js';

/** A TCP proxy to the broker that can stop forwarding while keeping both sockets open. */
async function silenceableProxy(): Promise<{ port: number; silence(): void; stop(): void }> {
  const sockets = new Set<net.Socket>();
  let silent = false;
  const server = net.createServer((client) => {
    const broker = net.connect(testBroker.amqpPort, testBroker.host);
    for (const socket of [client, broker]) {
      sockets.add(socket);
      socket.on('error', () => {});
    }
    client.on('data', (d) => void (silent || broker.write(d)));
    broker.on('data', (d) => void (silent || client.write(d)));
    // The client gives up on a silent broker too; the broker must not see that.
    client.on('close', () => silent || broker.destroy());
    broker.on('close', () => client.destroy());
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    port: (server.address() as net.AddressInfo).port,
    silence: () => void (silent = true),
    stop() {
      server.close();
      for (const socket of sockets) socket.destroy();
    },
  };
}

interface Doomed {
  conn: amqp.ChannelModel;
  /** Stops all traffic with the sockets left open. */
  silence(): void;
  /** Drops the socket, as the kernel does for a killed process. */
  dropSocket(): void;
  lock: string;
  queue: string;
  count: number;
}

/** A connection through the proxy holding a lock queue and Messages, as a Checkout does. */
async function doomedConnection(s: Scratch, type: QueueType, ctx: { onTestFinished(fn: () => void): void }, heartbeat?: number): Promise<Doomed> {
  const queue = await s.queue(`dead-${type}`, { 'x-queue-type': type });
  const bodies = ['m1', 'm2', 'm3'];
  await s.publish(queue, bodies);
  const proxy = await silenceableProxy();
  ctx.onTestFinished(() => proxy.stop());
  const conn = await amqp.connect({
    hostname: testBroker.host,
    port: proxy.port,
    username: brokerUsers.admin.username,
    password: brokerUsers.admin.password,
    ...(heartbeat === undefined ? {} : { heartbeat }),
  });
  conn.on('error', () => {});
  const lockChannel = await conn.createChannel();
  const lock = uniqueName('dead-lock');
  await lockChannel.assertQueue(lock, { exclusive: true, autoDelete: true, durable: false });
  // The global consumer timeout must not return the Messages first.
  const holder = await hold(conn, queue, bodies.length, type === 'quorum' ? { arguments: { 'x-consumer-timeout': 3_600_000 } } : {});
  await holder.ch.cancel(holder.consumerTag);
  return {
    conn,
    silence: proxy.silence,
    dropSocket: () => (conn.connection as unknown as { stream: net.Socket }).stream.destroy(),
    lock,
    queue,
    count: bodies.length,
  };
}

/** Whether another connection is still locked out of the lock queue. */
async function lockHeld(s: Scratch, lock: string): Promise<boolean> {
  const ch = await s.conn.createChannel();
  ch.on('error', () => {});
  const answer = await refusal(ch.checkQueue(lock));
  await ch.close().catch(() => {});
  if (/405 \(RESOURCE-LOCKED\)/.test(answer)) return true;
  expect(answer).toMatch(/404 \(NOT-FOUND\)/);
  return false;
}

/** Waits until the lock queue is gone and every Message is ready; ms for each, from `since`. */
async function released(s: Scratch, d: Doomed, since: number, limitMs: number): Promise<{ lock: number; messages: number }> {
  const out = { lock: 0, messages: 0 };
  while (!out.lock || !out.messages) {
    if (Date.now() - since > limitMs) throw new Error(`not released after ${limitMs} ms: ${JSON.stringify(out)}`);
    if (!out.lock && !(await lockHeld(s, d.lock))) out.lock = Date.now() - since;
    if (!out.messages && (await s.check(d.queue)).messageCount === d.count) out.messages = Date.now() - since;
    await sleep(50);
  }
  return out;
}

/** The Messages come back in order, and a quorum queue counts the return. */
async function expectReturnedByADeadConnection(s: Scratch, d: Doomed, type: QueueType): Promise<void> {
  const first = await take(s.ch, d.queue);
  expect(first.content.toString()).toBe('m1');
  expect(counts(first).deliveryCount).toBe(type === 'quorum' ? 1 : undefined);
  const second = await next(s.ch, d.queue, 1_000, { noAck: true });
  expect(second && second.content.toString()).toBe('m2');
}

describe.concurrent('Dead connections', () => {
  describe("When a connection's socket drops, as when its process is killed, the broker deletes its lock queue and returns its held Messages within a few seconds (under 100 ms on an idle broker).", () => {
    it.for(queueTypes)('%s', async (type, ctx) => {
      const s = await scratchFor(ctx);
      const d = await doomedConnection(s, type, ctx);
      expect(await lockHeld(s, d.lock)).toBe(true);
      const since = Date.now();
      d.dropSocket();
      await released(s, d, since, 5_000);
      await expectReturnedByADeadConnection(s, d, type);
    });
  });

  describe('When a connection goes silent with its socket still open, as when its host or network is lost, the broker keeps its lock queue and held Messages for about three heartbeat intervals, never less than two.', () => {
    it.for(queueTypes)('%s, with a heartbeat of 2 seconds', async (type, ctx) => {
      const s = await scratchFor(ctx);
      const d = await doomedConnection(s, type, ctx, 2);
      expect((d.conn.connection as unknown as { heartbeat: number }).heartbeat).toBe(2);
      const since = Date.now();
      d.silence();
      const after = await released(s, d, since, 12_000);
      expect(after.lock).toBeGreaterThanOrEqual(4_000);
      expect(after.messages).toBeGreaterThanOrEqual(4_000);
      await expectReturnedByADeadConnection(s, d, type);
    });
  });

  describe("A client that asks for no heartbeat gets the broker's default of 60 seconds, so a silent connection keeps its lock queue and held Messages for about three minutes.", () => {
    it.for(queueTypes)('%s', { timeout: 240_000 }, async (type, ctx) => {
      const s = await scratchFor(ctx);
      const d = await doomedConnection(s, type, ctx);
      expect((d.conn.connection as unknown as { heartbeat: number }).heartbeat).toBe(60);
      const since = Date.now();
      d.silence();
      const after = await released(s, d, since, 200_000);
      expect(after.lock).toBeGreaterThanOrEqual(120_000);
      expect(after.messages).toBeGreaterThanOrEqual(120_000);
      await expectReturnedByADeadConnection(s, d, type);
    });
  });
});
