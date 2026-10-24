// docs/rabbitmq-behaviour.md, "Dead-lettering headers". Each case builds its
// own topology: an exchange routing `a`, `b` and `c` to queues A, B and C,
// with A dead-lettering into DLQ.
import type * as amqp from 'amqplib';
import { describe, expect, it } from 'vitest';
import { eventually } from '../broker/client.js';
import { type QueueType, queueTypes, type Scratch, scratchFor } from './support.js';

interface Topology {
  ex: string;
  A: string;
  B: string;
  C: string;
  dlq: string;
}

async function topology(s: Scratch, type: QueueType, deadLetterRoutingKey?: string): Promise<Topology> {
  const ex = await s.exchange('dlh-ex', 'direct');
  const dlx = await s.exchange('dlh-dlx', 'direct');
  const A = await s.queue(`dlh-${type}-A`, {
    'x-queue-type': type,
    'x-dead-letter-exchange': dlx,
    ...(deadLetterRoutingKey ? { 'x-dead-letter-routing-key': deadLetterRoutingKey } : {}),
  });
  const B = await s.queue(`dlh-${type}-B`, { 'x-queue-type': type });
  const C = await s.queue(`dlh-${type}-C`, { 'x-queue-type': type });
  const dlq = await s.queue(`dlh-${type}-dlq`, { 'x-queue-type': type });
  await s.ch.bindQueue(A, ex, 'a');
  await s.ch.bindQueue(B, ex, 'b');
  await s.ch.bindQueue(C, ex, 'c');
  // The DLQ gets everything dead-lettered with routing key a (or the
  // dead-letter routing key). A copy routed by CC would need key b.
  await s.ch.bindQueue(dlq, dlx, deadLetterRoutingKey ?? 'a');
  return { ex, A, B, C, dlq };
}

async function publish(s: Scratch, ex: string, key: string, body: string, headers: Record<string, unknown>) {
  s.ch.publish(ex, key, Buffer.from(body), { headers });
  await s.ch.waitForConfirms();
}

/** Takes the one Message in `q` (waiting for it) and returns it. */
async function take(s: Scratch, q: string): Promise<amqp.GetMessage> {
  return eventually(async () => {
    const m = await s.ch.get(q, { noAck: true });
    if (!m) throw new Error(`nothing in ${q}`);
    return m;
  }, 3_000, 100);
}

/** Takes the one Message in `q` and rejects it without requeue, so it is dead-lettered. */
async function deadLetterFrom(s: Scratch, q: string): Promise<void> {
  const m = await eventually(async () => {
    const got = await s.ch.get(q);
    if (!got) throw new Error(`nothing in ${q}`);
    return got;
  }, 3_000, 100);
  s.ch.reject(m, false);
  await s.ch.checkQueue(q);
}

const headers = (m: amqp.Message) => m.properties.headers ?? {};

describe.concurrent('Dead-lettering headers', () => {
  describe('`BCC` is removed on publish. `CC` survives dead-lettering, even when `x-dead-letter-routing-key` is set.', () => {
    it.for(queueTypes)('%s: BCC routes a copy but is gone from every copy', async (type, ctx) => {
      const s = await scratchFor(ctx);
      const t = await topology(s, type);
      await publish(s, t.ex, 'a', 'hello', { CC: ['b'], BCC: ['c'], app: 'x' });
      for (const q of [t.A, t.B, t.C]) {
        const m = await take(s, q);
        expect(headers(m)).toEqual({ CC: ['b'], app: 'x' });
      }
    });

    it.for(queueTypes)('%s: CC is still on the dead-lettered Message', async (type, ctx) => {
      const s = await scratchFor(ctx);
      const t = await topology(s, type);
      await publish(s, t.ex, 'a', 'hello', { CC: ['b'] });
      await deadLetterFrom(s, t.A);
      const dead = await take(s, t.dlq);
      expect(headers(dead).CC).toEqual(['b']);
      expect(headers(dead)['x-death']).toEqual([expect.objectContaining({ 'routing-keys': ['a', 'b'] })]);
    });

    it.for(queueTypes)('%s: CC is still on the dead-lettered Message when x-dead-letter-routing-key is set', async (type, ctx) => {
      const s = await scratchFor(ctx);
      const t = await topology(s, type, 'dl');
      await publish(s, t.ex, 'a', 'hello', { CC: ['b'] });
      await deadLetterFrom(s, t.A);
      const dead = await take(s, t.dlq);
      expect(dead.fields.routingKey).toBe('dl');
      expect(headers(dead).CC).toEqual(['b']);
    });
  });

  describe('Republishing a dead-lettered Message with its `CC` header delivers copies to the `CC` queues again.', () => {
    it.for(queueTypes)('%s', async (type, ctx) => {
      const s = await scratchFor(ctx);
      const t = await topology(s, type);
      await publish(s, t.ex, 'a', 'hello', { CC: ['b'] });
      await take(s, t.B); // B's consumer handled its copy
      await deadLetterFrom(s, t.A);
      const dead = await take(s, t.dlq);

      await publish(s, t.ex, 'a', dead.content.toString(), headers(dead));

      expect((await take(s, t.A)).content.toString()).toBe('hello');
      expect((await take(s, t.B)).content.toString()).toBe('hello');
    });
  });

  describe('A client-supplied `x-death` reaches consumers untouched. When the Message is dead-lettered again, the broker discards it and starts a new history (`count: 1`, new `x-first-death-*`).', () => {
    const forged = {
      'x-death': [{ count: 99, reason: 'expired', queue: 'fake', exchange: 'fake', 'routing-keys': ['fake'] }],
      'x-first-death-reason': 'expired',
      'x-first-death-queue': 'fake',
      'x-first-death-exchange': 'fake',
    };

    it.for(queueTypes)('%s: consumers see the client-supplied x-death as published', async (type, ctx) => {
      const s = await scratchFor(ctx);
      const t = await topology(s, type);
      await publish(s, t.ex, 'b', 'forged', forged);
      expect(headers(await take(s, t.B))).toEqual(forged);
    });

    it.for(queueTypes)('%s: dead-lettering it again starts a new history', async (type, ctx) => {
      const s = await scratchFor(ctx);
      const t = await topology(s, type);
      await publish(s, t.ex, 'a', 'forged', forged);
      await deadLetterFrom(s, t.A);
      const h = headers(await take(s, t.dlq));
      expect(h['x-death']).toEqual([
        expect.objectContaining({ count: 1, reason: 'rejected', queue: t.A, exchange: t.ex, 'routing-keys': ['a'] }),
      ]);
      expect(h).toMatchObject({
        'x-first-death-reason': 'rejected',
        'x-first-death-queue': t.A,
        'x-first-death-exchange': t.ex,
      });
    });
  });
});
