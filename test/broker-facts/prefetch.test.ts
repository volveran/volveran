// docs/rabbitmq-behaviour.md, "Prefetch". A Checkout collects in windows
// (ADR 0006): it cannot widen a running consumer's prefetch, so each window
// is a new consumer on the same channel.
import type * as amqp from 'amqplib';
import { describe, expect, it } from 'vitest';
import { sleep } from '../broker/client.js';
import { queueTypes, type Scratch, scratchFor } from './support.js';

const tenMessages = Array.from({ length: 10 }, (_, i) => `m${i + 1}`);

/** A consumer on `ch` with prefetch `count` that records the bodies it is given into `got`. */
async function consume(ch: amqp.Channel, queue: string, count: number, got: string[]): Promise<string> {
  await ch.prefetch(count);
  const { consumerTag } = await ch.consume(queue, (m) => {
    if (m) got.push(m.content.toString());
  });
  return consumerTag;
}

async function queueWithTen(s: Scratch, type: string): Promise<string> {
  const q = await s.queue(`prefetch-${type}`, { 'x-queue-type': type });
  await s.publish(q, tenMessages);
  return q;
}

describe.concurrent('Prefetch', () => {
  describe('A new prefetch (`basic.qos`, global or not) does not apply to a consumer that already exists, on classic or quorum queues.', () => {
    for (const type of queueTypes) {
      for (const global of [false, true]) {
        it(`${type}, global ${global}: a consumer started with prefetch 2 still gets only 2 after a prefetch of 5`, async (ctx) => {
          const s = await scratchFor(ctx);
          const q = await queueWithTen(s, type);
          const ch = await s.conn.createChannel();
          const got: string[] = [];
          await ch.prefetch(2, global);
          await ch.consume(q, (m) => {
            if (m) got.push(m.content.toString());
          });
          await sleep(300);
          expect(got).toEqual(['m1', 'm2']);

          await ch.prefetch(5, global);
          await sleep(500);

          expect(got).toEqual(['m1', 'm2']);
        });
      }
    }
  });

  describe('A new consumer on the same channel, after one holding deliveries was cancelled, gets the next ready Messages in queue order.', () => {
    for (const type of queueTypes) {
      it(`${type}: windows of 2, 3 and 5 take m1..m10 in order, with nothing redelivered`, async (ctx) => {
        const s = await scratchFor(ctx);
        const q = await queueWithTen(s, type);
        const ch = await s.conn.createChannel();
        const got: string[] = [];
        for (const [window, total] of [[2, 2], [3, 5], [5, 10]] as const) {
          const tag = await consume(ch, q, window, got);
          const deadline = Date.now() + 3_000;
          while (got.length < total && Date.now() < deadline) await sleep(20);
          await ch.cancel(tag);
        }
        await sleep(200);

        expect(got).toEqual(tenMessages);
        expect((await s.check(q)).messageCount).toBe(0);
      });
    }
  });
});
