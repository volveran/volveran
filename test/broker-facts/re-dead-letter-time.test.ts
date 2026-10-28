// docs/rabbitmq-behaviour.md, "Re-dead-letter time". A queue dead-letters
// into a DLQ; the dead-lettered Message is republished to it the way Replay
// does (x-death and the other broker headers removed) and dead-lettered again.
import type * as amqp from 'amqplib';
import { describe, expect, it } from 'vitest';
import { sleep } from '../broker/client.js';
import { deadLetterFrom, queueTypes, scratchFor, take } from './support.js';

/** The headers Replay removes on republish (src/server/apply/republish.ts), copied here: this suite must not import src/. */
function replayHeaders(dead: amqp.Message): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(dead.properties.headers ?? {})) {
    if (['CC', 'BCC', 'x-death', 'x-delivery-count', 'x-acquired-count'].includes(k)) continue;
    if (k.startsWith('x-first-death-') || k.startsWith('x-last-death-')) continue;
    out[k] = v;
  }
  return { ...out, 'x-volveran-replay-id': 'replay-1' };
}

type Death = { count: number; time: { '!': 'timestamp'; value: number } };
const deaths = (m: amqp.Message) => m.properties.headers?.['x-death'] as Death[];

describe.concurrent('Re-dead-letter time', () => {
  describe('A Message republished with `x-death` removed (as Replay does, ADR 0005) and dead-lettered again carries a single fresh `x-death` entry (`count: 1`) whose `time` is the new dead-lettering, not the first one.', () => {
    it.for(queueTypes)('%s', async (type, ctx) => {
      const s = await scratchFor(ctx);
      const dlx = await s.exchange('rdt-dlx', 'fanout');
      const work = await s.queue(`rdt-${type}-work`, { 'x-queue-type': type, 'x-dead-letter-exchange': dlx });
      const dlq = await s.queue(`rdt-${type}-dlq`, { 'x-queue-type': type });
      await s.ch.bindQueue(dlq, dlx, '');

      await s.publish(work, ['order'], { headers: { app: 'x' } });
      await deadLetterFrom(s.ch, work);
      const first = await take(s.ch, dlq);
      const firstTime = deaths(first)[0]!.time.value;

      // x-death time has one-second resolution: wait long enough to tell them apart.
      await sleep(2_500);
      await s.publish(work, [first.content.toString()], { headers: replayHeaders(first) });
      const before = Math.floor(Date.now() / 1000);
      await deadLetterFrom(s.ch, work);
      const after = Math.ceil(Date.now() / 1000);
      const second = await take(s.ch, dlq);

      expect(second.properties.headers?.['x-volveran-replay-id']).toBe('replay-1');
      expect(deaths(second)).toEqual([expect.objectContaining({ count: 1, reason: 'rejected', queue: work })]);
      const secondTime = deaths(second)[0]!.time.value;
      expect(secondTime).toBeGreaterThanOrEqual(firstTime + 2);
      expect(secondTime).toBeGreaterThanOrEqual(before);
      expect(secondTime).toBeLessThanOrEqual(after);
    });
  });

  describe('`x-death` `time` is an AMQP timestamp: whole seconds since the epoch.', () => {
    it.for(queueTypes)('%s', async (type, ctx) => {
      const s = await scratchFor(ctx);
      const dlx = await s.exchange('rdt-dlx', 'fanout');
      const work = await s.queue(`rdt-${type}-work`, { 'x-queue-type': type, 'x-dead-letter-exchange': dlx });
      const dlq = await s.queue(`rdt-${type}-dlq`, { 'x-queue-type': type });
      await s.ch.bindQueue(dlq, dlx, '');

      await s.publish(work, ['order']);
      const before = Math.floor(Date.now() / 1000);
      await deadLetterFrom(s.ch, work);
      const after = Math.ceil(Date.now() / 1000);
      const { time } = deaths(await take(s.ch, dlq))[0]!;

      expect(time['!']).toBe('timestamp');
      expect(Number.isInteger(time.value)).toBe(true);
      expect(time.value).toBeGreaterThanOrEqual(before);
      expect(time.value).toBeLessThanOrEqual(after);
    });
  });
});
