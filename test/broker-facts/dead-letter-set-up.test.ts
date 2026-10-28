// docs/rabbitmq-behaviour.md, "Dead-letter set-up": the set-ups that lose
// dead-lettered Messages, behind the queue list's set-up checks
// (src/server/triage/setup-checks.ts). Each case builds its own topology.
import { describe, expect, it } from 'vitest';
import { eventually, management, sleep, uniqueName } from '../broker/client.js';
import { next, queueTypes, type Scratch, scratchFor } from './support.js';

/** Takes the one Message in `q` and rejects it without requeue, so it is dead-lettered. */
async function deadLetterFrom(s: Scratch, q: string): Promise<void> {
  const m = await next(s.ch, q, 3_000);
  if (!m) throw new Error(`nothing in ${q}`);
  s.ch.reject(m, false);
  await s.check(q);
}

/** Polls `read` until it returns `expected`, accumulating across reads. */
async function expectEventually(read: () => Promise<string[]>, expected: string[], ms = 5_000): Promise<void> {
  const got: string[] = [];
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    got.push(...(await read()));
    if (got.length >= expected.length) break;
    await sleep(100);
  }
  expect(got).toEqual(expected);
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
  describe('A dead-letter queue with a message TTL and no dead-letter exchange of its own drops Messages once they expire.', () => {
    it.for(queueTypes)('%s: an expired Message is gone; with a dead-letter exchange of its own it is dead-lettered onward', async (type, ctx) => {
      const s = await scratchFor(ctx);
      const dlq = await s.queue(`dls-${type}-ttl`, { 'x-queue-type': type, 'x-message-ttl': 200 });
      await s.publish(dlq, ['expired']);
      await sleep(800);
      expect(await s.bodies(dlq)).toEqual([]);

      const onward = await s.exchange('dls-ttl-onward', 'fanout');
      const parked = await s.queue(`dls-${type}-ttl-parked`);
      await s.ch.bindQueue(parked, onward, '');
      const kept = await s.queue(`dls-${type}-ttl-kept`, { 'x-queue-type': type, 'x-message-ttl': 200, 'x-dead-letter-exchange': onward });
      await s.publish(kept, ['expired']);
      await expectEventually(() => s.bodies(parked), ['expired']);
    });
  });

  describe('A dead-letter queue with a length limit and the default `drop-head` overflow drops its oldest Messages when full, unless it has a dead-letter exchange of its own.', () => {
    it.for(queueTypes)('%s: the oldest Message is gone; with a dead-letter exchange of its own it is dead-lettered onward', async (type, ctx) => {
      const s = await scratchFor(ctx);
      const dlq = await s.queue(`dls-${type}-drop-head`, { 'x-queue-type': type, 'x-max-length': 1 });
      await s.publish(dlq, ['first', 'second']);
      await sleep(300);
      expect(await s.bodies(dlq)).toEqual(['second']);

      const onward = await s.exchange('dls-drop-head-onward', 'fanout');
      const parked = await s.queue(`dls-${type}-drop-head-parked`);
      await s.ch.bindQueue(parked, onward, '');
      const kept = await s.queue(`dls-${type}-drop-head-kept`, { 'x-queue-type': type, 'x-max-length': 1, 'x-dead-letter-exchange': onward });
      await s.publish(kept, ['first', 'second']);
      await expectEventually(() => s.bodies(parked), ['first']);
    });
  });

  describe('A queue that expires (`x-expires`) is deleted with its Messages, which are not dead-lettered even when it has a dead-letter exchange.', () => {
    it.for(queueTypes)('%s: the queue and its Message are gone, and its dead-letter exchange gets nothing', async (type, ctx) => {
      const s = await scratchFor(ctx);
      const onward = await s.exchange('dls-expires-onward', 'fanout');
      const parked = await s.queue(`dls-${type}-expires-parked`);
      await s.ch.bindQueue(parked, onward, '');
      const dlq = await s.queue(`dls-${type}-expires`, { 'x-queue-type': type, 'x-expires': 1_000, 'x-dead-letter-exchange': onward });
      await s.publish(dlq, ['lost']);
      // Quorum queues check their expiry less often than classic ones. Poll the management API:
      // a passive declare counts as using the queue, which restarts a classic queue's expiry.
      await eventually(async () => expect((await management(`/queues/%2F/${encodeURIComponent(dlq)}`)).status).toBe(404), 20_000, 500);
      expect(await s.bodies(parked)).toEqual([]);
    });
  });

  describe('The default quorum dead-letter strategy is `at-most-once`: a Message dead-lettered to an exchange that routes it to no queue is dropped. With `at-least-once` (which needs `reject-publish` overflow) the queue keeps it, not ready, and retries.', () => {
    it('quorum: the management API counts the Message in the at-least-once queue only, and a queue bound later to the at-most-once exchange gets nothing', async (ctx) => {
      const s = await scratchFor(ctx);
      const strategies = { 'at-most-once': {}, 'at-least-once': { 'x-dead-letter-strategy': 'at-least-once', 'x-overflow': 'reject-publish' } };
      const queues: Record<string, string> = {};
      const exchanges: Record<string, string> = {};
      for (const [strategy, args] of Object.entries(strategies)) {
        exchanges[strategy] = await s.exchange(`dls-${strategy}-dlx`, 'fanout');
        queues[strategy] = await s.queue(`dls-${strategy}`, { 'x-queue-type': 'quorum', 'x-dead-letter-exchange': exchanges[strategy], ...args });
        await s.publish(queues[strategy]!, [strategy]);
        await deadLetterFrom(s, queues[strategy]!);
      }
      // Management statistics lag (see "Queue counts"); a passive declare counts ready Messages only.
      const messages = async (q: string) => (await management(`/queues/%2F/${encodeURIComponent(q)}`)).body.messages;
      await eventually(async () => {
        expect(await messages(queues['at-least-once']!)).toBe(1);
        expect(await messages(queues['at-most-once']!)).toBe(0);
      }, 20_000, 500);
      expect(await s.check(queues['at-least-once']!)).toMatchObject({ messageCount: 0 });

      const parked = await s.queue('dls-at-most-once-parked');
      await s.ch.bindQueue(parked, exchanges['at-most-once']!, '');
      await sleep(1_000);
      expect(await s.bodies(parked)).toEqual([]);
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
