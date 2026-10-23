// docs/rabbitmq-behaviour.md, "Exclusivity".
import { describe, expect, it } from 'vitest';
import { eventually, management, sleep } from '../broker/client.js';
import { queueTypes, refusal, scratchFor } from './support.js';

describe('Exclusivity', () => {
  describe('Exclusive consume is honoured on classic queues and silently ignored on quorum queues.', () => {
    it('classic: a second consumer next to an exclusive one is refused with 403 ACCESS_REFUSED', async (ctx) => {
      const s = await scratchFor(ctx);
      const q = await s.queue('excl-classic', { 'x-queue-type': 'classic' });
      await s.ch.consume(q, () => {}, { exclusive: true });
      const other = await s.conn.createChannel();
      other.on('error', () => {});
      expect(await refusal(other.consume(q, () => {}))).toMatch(/403 \(ACCESS-REFUSED\).*in exclusive use/);
    });

    it('quorum: consumers next to an exclusive one are accepted and get Messages', async (ctx) => {
      const s = await scratchFor(ctx);
      const q = await s.queue('excl-quorum', { 'x-queue-type': 'quorum' });
      const a = await s.conn.createChannel();
      const b = await s.conn.createChannel();
      const got = { a: 0, b: 0 };
      await a.consume(q, () => got.a++, { exclusive: true, noAck: true });
      await b.consume(q, () => got.b++, { noAck: true });
      expect((await s.check(q)).consumerCount).toBe(2);
      await s.publish(q, ['m1', 'm2', 'm3', 'm4']);
      await eventually(async () => expect(got.a + got.b).toBe(4), 3_000, 50);
      expect(got.a).toBeGreaterThan(0);
      expect(got.b).toBeGreaterThan(0);
    });
  });

  describe('Single-active-consumer works on both, but only as a queue argument at declaration; policies cannot set it.', () => {
    it.for(queueTypes)('%s: with x-single-active-consumer only the first consumer gets Messages until it goes away', async (type, ctx) => {
      const s = await scratchFor(ctx);
      const q = await s.queue(`sac-${type}`, { 'x-queue-type': type, 'x-single-active-consumer': true });
      const first = await s.conn.createChannel();
      const second = await s.conn.createChannel();
      const got: string[] = [];
      await first.consume(q, (m) => m && got.push(`first:${m.content}`));
      await second.consume(q, (m) => m && got.push(`second:${m.content}`));
      await s.publish(q, ['m1', 'm2']);
      await eventually(async () => expect(got).toHaveLength(2), 3_000, 50);
      await sleep(300); // nothing more arrives at the second consumer
      expect(got).toEqual(['first:m1', 'first:m2']);

      await first.close();
      await eventually(async () => expect(got).toHaveLength(4), 3_000, 50);
      expect(got.slice(2).sort()).toEqual(['second:m1', 'second:m2']);
    });

    it.each(['single-active-consumer', 'x-single-active-consumer'])('a policy with %s is refused', async (key) => {
      const res = await management('/policies/%2F/facts-sac', {
        method: 'PUT',
        body: { pattern: '^facts\\.sac-policy$', definition: { [key]: true }, 'apply-to': 'queues' },
      });
      expect(res.status).toBe(400);
      expect(JSON.stringify(res.body)).toMatch(/not recognised policy settings/);
    });

    it('it cannot be added to an existing queue by declaring it again', async (ctx) => {
      const s = await scratchFor(ctx);
      const q = await s.queue('sac-redeclare', { 'x-queue-type': 'quorum' });
      const ch = await s.conn.createChannel();
      ch.on('error', () => {});
      expect(
        await refusal(ch.assertQueue(q, { durable: true, arguments: { 'x-queue-type': 'quorum', 'x-single-active-consumer': true } })),
      ).toMatch(/406 \(PRECONDITION-FAILED\).*inequivalent arg 'x-single-active-consumer'/);
    });
  });
});
