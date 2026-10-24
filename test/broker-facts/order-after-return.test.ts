// docs/rabbitmq-behaviour.md, "Order after a return". Ten Messages m1..m10;
// take m1..m5, return m4 and then m2, ack the rest.
import type * as amqp from 'amqplib';
import { describe, expect, it } from 'vitest';
import { eventually } from '../broker/client.js';
import { type QueueType, type Scratch, scratchFor } from './support.js';

async function orderAfterReturningM4ThenM2(s: Scratch, type: QueueType): Promise<string[]> {
  const q = await s.queue(`order-${type}`, { 'x-queue-type': type });
  await s.publish(q, Array.from({ length: 10 }, (_, i) => `m${i + 1}`));
  const ch = await s.conn.createChannel();
  const taken: amqp.GetMessage[] = [];
  for (let i = 0; i < 5; i++) {
    const m = await ch.get(q);
    if (!m) throw new Error(`only ${i} Messages in ${q}`);
    taken.push(m);
  }
  ch.nack(taken[3]!, false, true);
  ch.nack(taken[1]!, false, true);
  for (const i of [0, 2, 4]) ch.ack(taken[i]!);
  await ch.close();
  await eventually(async () => expect((await s.check(q)).messageCount).toBe(7), 3_000, 50);
  return s.bodies(q);
}

describe.concurrent('Order after a return', () => {
  describe('Classic queues put a returned Message back in its original position.', () => {
    it('m2 and m4 come back in their original order, ahead of m6', async (ctx) => {
      const s = await scratchFor(ctx);
      expect(await orderAfterReturningM4ThenM2(s, 'classic')).toEqual(['m2', 'm4', 'm6', 'm7', 'm8', 'm9', 'm10']);
    });
  });

  describe('Quorum queues put returned Messages ahead of newer ones, in the order they were returned.', () => {
    it('m4 then m2 come first, in return order, ahead of m6', async (ctx) => {
      const s = await scratchFor(ctx);
      expect(await orderAfterReturningM4ThenM2(s, 'quorum')).toEqual(['m4', 'm2', 'm6', 'm7', 'm8', 'm9', 'm10']);
    });
  });
});
