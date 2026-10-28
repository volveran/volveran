// docs/rabbitmq-behaviour.md, "Canary watch" and "Watch queue lifetime". A
// work queue dead-letters into a DLQ through a direct, fanout or topic
// dead-letter exchange; a watch queue, exclusive to a second connection, is
// bound to the same exchange with the DLQ's binding.
import type * as amqp from 'amqplib';
import { describe, expect, it } from 'vitest';
import { connect, eventually, openChannel, uniqueName } from '../broker/client.js';
import { deadLetterFrom, queueTypes, refusal, scratchFor, take } from './support.js';

const deadLetterExchanges = [
  { type: 'direct', binding: 'orders.created' },
  { type: 'fanout', binding: '' },
  { type: 'topic', binding: 'orders.*' },
] as const;

const cases = queueTypes.flatMap((queueType) => deadLetterExchanges.map((dlx) => ({ queueType, ...dlx })));

/** Declares an exclusive, auto-delete watch queue on `ch`, as the Canary watch does. */
async function declareWatch(ch: amqp.Channel): Promise<string> {
  const { queue } = await ch.assertQueue(uniqueName('canary-watch'), { exclusive: true, autoDelete: true, durable: false });
  return queue;
}

/** The refusal a passive declare of `queue` gets on a fresh connection, or 'accepted'. */
async function passiveDeclare(queue: string): Promise<string> {
  const conn = await connect();
  try {
    return await refusal((await openChannel(conn)).checkQueue(queue));
  } finally {
    await conn.close().catch(() => {});
  }
}

describe.concurrent('Canary watch', () => {
  describe('A queue bound to a dead-letter exchange with the same binding as the dead-letter queue receives a copy of a Message dead-lettered there, with `x-volveran-replay-id` intact, and the dead-letter queue still receives its own copy. This holds for direct, fanout and topic dead-letter exchanges, from classic and quorum source queues.', () => {
    it.for(cases)('$type dead-letter exchange, $queueType source queue', async ({ queueType, type, binding }, ctx) => {
      const s = await scratchFor(ctx);
      const origin = await s.exchange('cw-origin', 'direct');
      const dlx = await s.exchange(`cw-dlx-${type}`, type);
      const work = await s.queue(`cw-${queueType}-work`, { 'x-queue-type': queueType, 'x-dead-letter-exchange': dlx });
      const dlq = await s.queue(`cw-${queueType}-dlq`, { 'x-queue-type': queueType });
      await s.ch.bindQueue(work, origin, 'orders.created');
      await s.ch.bindQueue(dlq, dlx, binding);

      const watcher = await connect();
      ctx.onTestFinished(() => watcher.close().catch(() => {}));
      const watchCh = await openChannel(watcher);
      const watch = await declareWatch(watchCh);
      await watchCh.bindQueue(watch, dlx, binding);

      s.ch.publish(origin, 'orders.created', Buffer.from('canary'), { headers: { 'x-volveran-replay-id': 'replay-1' } });
      await s.ch.waitForConfirms();
      await deadLetterFrom(s.ch, work);

      const copy = await take(watchCh, watch);
      expect(copy.content.toString()).toBe('canary');
      expect(copy.properties.headers?.['x-volveran-replay-id']).toBe('replay-1');
      expect(copy.properties.headers?.['x-death']).toEqual([expect.objectContaining({ reason: 'rejected', queue: work })]);

      const own = await take(s.ch, dlq);
      expect(own.content.toString()).toBe('canary');
      expect(own.properties.headers?.['x-volveran-replay-id']).toBe('replay-1');
      expect((await s.check(dlq)).messageCount).toBe(0);
    });
  });
});

describe.concurrent('Watch queue lifetime', () => {
  describe('An exclusive, auto-delete queue declared on a connection disappears when that connection closes, whether the client closes it or the socket drops.', () => {
    it.for(['the client closes it', 'the socket drops'] as const)('%s', async (how) => {
      const owner = await connect();
      const ownerCh = await openChannel(owner);
      const watch = await declareWatch(ownerCh);
      expect(await passiveDeclare(watch)).toMatch(/405 \(RESOURCE-LOCKED\)/);

      if (how === 'the client closes it') await owner.close();
      else (owner.connection as unknown as { stream: { destroy(): void } }).stream.destroy();

      await eventually(async () => expect(await passiveDeclare(watch)).toMatch(/404 \(NOT-FOUND\)/), 10_000, 200);
    });
  });
});
