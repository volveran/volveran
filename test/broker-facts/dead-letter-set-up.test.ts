// docs/rabbitmq-behaviour.md, "Dead-letter set-up": the set-ups that lose
// dead-lettered Messages, behind the queue list's set-up checks
// (src/server/triage/setup-checks.ts). Each case builds its own topology.
import { describe, expect, it } from 'vitest';
import { sleep, uniqueName } from '../broker/client.js';
import { next, queueTypes, type Scratch, scratchFor } from './support.js';

/** Takes the one Message in `q` and rejects it without requeue, so it is dead-lettered. */
async function deadLetterFrom(s: Scratch, q: string): Promise<void> {
  const m = await next(s.ch, q, 3_000);
  if (!m) throw new Error(`nothing in ${q}`);
  s.ch.reject(m, false);
  await s.check(q);
}

describe.concurrent('Dead-letter set-up', () => {
  describe('A queue whose dead-letter exchange does not exist drops the Messages it dead-letters.', () => {
    it.for(queueTypes)('%s: the rejected Message is gone, and an exchange of that name declared later gets nothing', async (type, ctx) => {
      const s = await scratchFor(ctx);
      const missing = uniqueName('dls-missing-dlx');
      const q = await s.queue(`dls-${type}-missing-dlx`, { 'x-queue-type': type, 'x-dead-letter-exchange': missing });
      await s.publish(q, ['lost']);
      await deadLetterFrom(s, q);
      await sleep(300);
      expect(await s.check(q)).toMatchObject({ messageCount: 0 });

      // Nothing was held back for the exchange: declaring it now delivers nothing.
      await s.ch.assertExchange(missing, 'fanout', { durable: false, autoDelete: true });
      const dlq = await s.queue(`dls-${type}-late-dlq`);
      await s.ch.bindQueue(dlq, missing, '');
      await sleep(500);
      expect(await s.bodies(dlq)).toEqual([]);
    });
  });

  describe('A dead-letter exchange that routes the dead-letter routing key to no queue drops the Message, on classic and quorum queues alike. A binding added afterwards gets nothing.', () => {
    it.for(queueTypes)('%s: the rejected Message reaches no queue, and a binding added later gets nothing', async (type, ctx) => {
      const s = await scratchFor(ctx);
      const dlx = await s.exchange('dls-unroutable-dlx', 'direct');
      const dlq = await s.queue(`dls-${type}-unroutable-dlq`);
      await s.ch.bindQueue(dlq, dlx, 'parked');
      const q = await s.queue(`dls-${type}-unroutable`, {
        'x-queue-type': type,
        'x-dead-letter-exchange': dlx,
        'x-dead-letter-routing-key': 'elsewhere',
      });
      await s.publish(q, ['lost']);
      await deadLetterFrom(s, q);
      await sleep(300);
      expect(await s.check(q)).toMatchObject({ messageCount: 0 });
      expect(await s.bodies(dlq)).toEqual([]);

      // Nothing was held back: a binding for the key added now delivers nothing.
      await s.ch.bindQueue(dlq, dlx, 'elsewhere');
      await sleep(500);
      expect(await s.bodies(dlq)).toEqual([]);
    });
  });

  describe('An alternate exchange on the dead-letter exchange saves the Message: it reaches the alternate exchange\'s queues.', () => {
    it.for(queueTypes)('%s: with an alternate exchange on the dead-letter exchange, the Message reaches the alternate exchange\'s queue', async (type, ctx) => {
      const s = await scratchFor(ctx);
      const alternate = await s.exchange('dls-alternate', 'fanout');
      const saved = await s.queue(`dls-${type}-alternate-q`);
      await s.ch.bindQueue(saved, alternate, '');
      const dlx = uniqueName('dls-dlx-with-alternate');
      await s.ch.assertExchange(dlx, 'direct', { durable: false, arguments: { 'alternate-exchange': alternate } });
      ctx.onTestFinished(async () => {
        await s.ch.deleteExchange(dlx).catch(() => {});
      });
      const q = await s.queue(`dls-${type}-alternate`, {
        'x-queue-type': type,
        'x-dead-letter-exchange': dlx,
        'x-dead-letter-routing-key': 'elsewhere',
      });
      await s.publish(q, ['saved']);
      await deadLetterFrom(s, q);
      const m = await next(s.ch, saved, 3_000, { noAck: true });
      expect(m && m.content.toString()).toBe('saved');
    });
  });
});
