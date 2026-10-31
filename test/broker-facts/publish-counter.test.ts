// docs/rabbitmq-behaviour.md, "Publish counter": the broker-facts gate for
// depth history's arrival count (#71). `message_stats` comes from statistics
// the broker emits every 5 s (RabbitMQ's default collect_statistics_interval,
// kept in test/broker/rabbitmq.conf).
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import { composeFile, repoRoot, testBrokerSettings } from '../../scripts/test-broker-env.mjs';
import { eventually, management, sleep } from '../broker/client.js';
import { deadLetterFrom, queueTypes, scratchFor, type Scratch } from './support.js';

/** Long enough for two statistics emissions, so a counter still absent after it is not just late. */
const TWO_EMISSIONS_MS = 12_000;

const queuePath = (q: string) => `/queues/%2F/${encodeURIComponent(q)}`;

async function details(q: string): Promise<any> {
  const res = await management(queuePath(q));
  if (res.status !== 200) throw new Error(`${q}: HTTP ${res.status}`);
  return res.body;
}

async function untilDepth(q: string, depth: number, timeoutMs = 30_000): Promise<any> {
  return eventually(async () => {
    const body = await details(q);
    if (body.messages !== depth) throw new Error(`${q} shows ${body.messages} Messages, expected ${depth}`);
    return body;
  }, timeoutMs, 100);
}

async function untilPublishCount(q: string, count: number, timeoutMs = 30_000): Promise<any> {
  return eventually(async () => {
    const body = await details(q);
    if (body.message_stats?.publish !== count) {
      throw new Error(`${q} shows publish ${body.message_stats?.publish}, expected ${count}`);
    }
    return body;
  }, timeoutMs, 100);
}

/** A queue that dead-letters through `dlx`, optionally with a Message TTL so its Messages expire. */
const sourceArgs = (type: string, dlx: string, ttl?: number): Record<string, unknown> => ({
  'x-queue-type': type,
  'x-dead-letter-exchange': dlx,
  ...(ttl === undefined ? {} : { 'x-message-ttl': ttl }),
});

async function dlqBehind(s: Scratch, type: string, path: 'direct' | 'exchange-to-exchange') {
  const dlq = await s.queue(`pc-dlq-${type}`, { 'x-queue-type': type });
  const dlx = await s.exchange('pc-dlx', 'fanout');
  if (path === 'direct') {
    await s.ch.bindQueue(dlq, dlx, '');
  } else {
    const inner = await s.exchange('pc-inner', 'fanout');
    await s.ch.bindExchange(inner, dlx, '');
    await s.ch.bindQueue(dlq, inner, '');
  }
  return { dlq, dlx };
}

/** Restarts RabbitMQ in the test broker's container, keeping its data and published ports. */
async function restartBroker(): Promise<void> {
  const { project } = testBrokerSettings(repoRoot, process.env);
  const ctl = (command: string) =>
    promisify(execFile)('docker', ['compose', '-p', project, '-f', composeFile, 'exec', '-T', 'rabbitmq', 'rabbitmqctl', command]);
  await ctl('stop_app');
  await ctl('start_app');
}

const cases = queueTypes.flatMap((dlqType) =>
  queueTypes.flatMap((sourceType) =>
    (['direct', 'exchange-to-exchange'] as const).flatMap((path) =>
      (['rejected', 'expired'] as const).map((how) => ({ dlqType, sourceType, path, how })),
    ),
  ),
);

describe('Publish counter', () => {
  describe.concurrent('Dead-lettering does not count in the receiving queue\'s `message_stats.publish`: on classic and quorum queues, for rejected and expired Messages, through the dead-letter exchange directly or through an exchange-to-exchange binding, the Message adds to the depth and the counter stays absent. Only a client\'s publish counts.', () => {
    it.for(cases)('$how from a $sourceType queue into a $dlqType queue, $path', async ({ dlqType, sourceType, path, how }, ctx) => {
      const s = await scratchFor(ctx);
      const { dlq, dlx } = await dlqBehind(s, dlqType, path);
      const source = await s.queue(`pc-src-${sourceType}`, sourceArgs(sourceType, dlx, how === 'expired' ? 50 : undefined));

      await s.publish(source, ['dead']);
      if (how === 'rejected') await deadLetterFrom(s.ch, source);

      await untilDepth(dlq, 1);
      await sleep(TWO_EMISSIONS_MS);
      expect((await details(dlq)).message_stats?.publish).toBeUndefined();

      // The counter works on this very queue: a client's publish shows, alone.
      await s.publish(dlq, ['direct']);
      const after = await untilPublishCount(dlq, 1);
      await untilDepth(dlq, 2);
      expect(after.message_stats.publish).toBe(1);
    });
  });

  describe.concurrent('A client\'s publish shows in `message_stats.publish` within about 5 seconds of its confirm, one statistics interval.', () => {
    it.for(queueTypes)('%s', async (type, ctx) => {
      const s = await scratchFor(ctx);
      const lags: number[] = [];
      for (let round = 0; round < 3; round++) {
        const q = await s.queue(`pc-lag-${type}`, { 'x-queue-type': type });
        await s.publish(q, ['a', 'b', 'c']);
        const confirmedAt = Date.now();
        await untilPublishCount(q, 3);
        lags.push(Date.now() - confirmedAt);
      }
      await ctx.annotate(`publish counter caught up after ${lags.join(', ')} ms`);
      for (const lag of lags) expect(lag).toBeLessThan(15_000);
    });
  });

  describe.concurrent('A queue with no traffic yet reports no `message_stats` at all, rather than a zero count.', () => {
    it.for(queueTypes)('%s', async (type, ctx) => {
      const s = await scratchFor(ctx);
      const q = await s.queue(`pc-empty-${type}`, { 'x-queue-type': type });
      await untilDepth(q, 0);
      await sleep(TWO_EMISSIONS_MS);
      expect((await details(q)).message_stats).toBeUndefined();
    });
  });

  describe.concurrent('Deleting and re-declaring a queue resets its `message_stats.publish`, so a reading can be lower than the previous one.', () => {
    it.for(queueTypes)('%s', async (type, ctx) => {
      const s = await scratchFor(ctx);
      const q = await s.queue(`pc-redeclare-${type}`, { 'x-queue-type': type });
      await s.publish(q, ['a', 'b', 'c']);
      await untilPublishCount(q, 3);

      await s.ch.deleteQueue(q);
      await s.ch.assertQueue(q, { durable: true, arguments: { 'x-queue-type': type } });
      await s.publish(q, ['d']);

      await untilPublishCount(q, 1);
    });
  });

  // Not concurrent: the restart closes every connection to the broker.
  describe('A broker restart resets `message_stats.publish`, so a reading can be lower than the previous one. Durable Messages keep the queue\'s depth across it.', () => {
    it('classic and quorum', { timeout: 240_000 }, async (ctx) => {
      const s = await scratchFor(ctx);
      const queues = await Promise.all(queueTypes.map((type) => s.queue(`pc-restart-${type}`, { 'x-queue-type': type })));
      for (const q of queues) {
        await s.publish(q, ['a', 'b', 'c'], { persistent: true });
        await untilPublishCount(q, 3);
      }

      await restartBroker();

      const after = await scratchFor(ctx);
      for (const q of queues) {
        const body = await untilDepth(q, 3, 90_000);
        expect(body.message_stats?.publish ?? 0).toBeLessThan(3);
        await eventually(() => after.check(q), 60_000, 500);
        await after.publish(q, ['d'], { persistent: true });
        await untilPublishCount(q, 1, 60_000);
        await untilDepth(q, 4, 60_000);
        await management(queuePath(q), { method: 'DELETE' });
      }
    });
  });
});
