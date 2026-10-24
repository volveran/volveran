// docs/rabbitmq-behaviour.md, "Delivery counting (quorum queues)".
import type * as amqp from 'amqplib';
import { describe, expect, it } from 'vitest';
import { connect, eventually, management, sleep } from '../broker/client.js';
import { hold, next, type QueueType, type Scratch, scratchFor, within } from './support.js';

type Return = 'nack' | 'reject' | 'channel-close' | 'connection-close' | 'consumer-timeout' | 'recover';

/**
 * Puts one Message into a fresh queue of `type`, takes it, returns it the
 * way `how` says, and gives back the next delivery of it.
 */
async function returnedOnce(s: Scratch, type: QueueType, how: Return): Promise<amqp.GetMessage> {
  const q = await s.queue(`dc-${type}-${how}`, { 'x-queue-type': type });
  await s.publish(q, ['m1']);
  if (how === 'consumer-timeout') {
    const holder = await hold(s.conn, q, 1, { arguments: { 'x-consumer-timeout': 1_000 } });
    expect(await within(holder.brokerCancel, 5_000)).not.toBe('nothing');
  } else if (how === 'connection-close') {
    const conn = await connect();
    const ch = await conn.createChannel();
    expect(await ch.get(q)).toBeTruthy();
    await conn.close();
  } else {
    const ch = await s.conn.createChannel();
    const m = await ch.get(q);
    if (!m) throw new Error(`nothing in ${q}`);
    if (how === 'nack') ch.nack(m, false, true);
    if (how === 'reject') ch.reject(m, true);
    if (how === 'recover') await ch.recover();
    if (how === 'channel-close') await ch.close();
    else await ch.checkQueue(q); // round trip so the return is processed
  }
  return eventually(async () => {
    const m = await s.ch.get(q, { noAck: true });
    if (!m) throw new Error(`the Message did not come back to ${q}`);
    return m;
  }, 3_000, 100);
}

const headers = (m: amqp.Message) => m.properties.headers ?? {};

describe.concurrent('Delivery counting (quorum queues)', () => {
  describe('`x-delivery-count` increases on some returns only (table)', () => {
    const table: Array<[Return, string, boolean]> = [
      ['nack', '`nack` with requeue', false],
      ['reject', '`reject` with requeue', true],
      ['channel-close', 'Channel or connection closed with the Message unacknowledged (channel)', true],
      ['connection-close', 'Channel or connection closed with the Message unacknowledged (connection)', true],
      ['consumer-timeout', 'Consumer timeout', false],
      ['recover', '`basic.recover`', false],
    ];
    it.for(table)('%s: "%s" → x-delivery-count increases: %s', async ([how, , increases], ctx) => {
      const s = await scratchFor(ctx);
      const m = await returnedOnce(s, 'quorum', how);
      expect(m.fields.redelivered).toBe(true);
      expect(headers(m)['x-delivery-count']).toBe(increases ? 1 : undefined);
    });
  });

  describe('`x-acquired-count` increases on every return.', () => {
    it.for(['nack', 'reject', 'channel-close', 'connection-close', 'consumer-timeout', 'recover'] as Return[])(
      '%s',
      async (how, ctx) => {
        const s = await scratchFor(ctx);
        const m = await returnedOnce(s, 'quorum', how);
        expect(headers(m)['x-acquired-count']).toBe(1);
      },
    );

    it('counts up with each return', async (ctx) => {
      const s = await scratchFor(ctx);
      const q = await s.queue('dc-acquired', { 'x-queue-type': 'quorum' });
      await s.publish(q, ['m1']);
      const seen: unknown[] = [];
      for (let i = 0; i < 3; i++) {
        const m = await next(s.ch, q);
        if (!m) throw new Error('empty');
        seen.push(headers(m)['x-acquired-count']);
        s.ch.nack(m, false, true);
        await s.check(q);
      }
      expect(seen).toEqual([undefined, 1, 2]);
    });
  });

  describe("The default `delivery-limit` is 20 and is shown as `delivery_limit` in the queue's management API details, not in its arguments.", () => {
    it('a quorum queue declared without x-delivery-limit shows delivery_limit 20 and no limit argument', async (ctx) => {
      const s = await scratchFor(ctx);
      const q = await s.queue('dc-default-limit', { 'x-queue-type': 'quorum' });
      const body = await eventually(async () => {
        const res = await management(`/queues/%2F/${encodeURIComponent(q)}`);
        expect(res.body).toHaveProperty('delivery_limit');
        return res.body;
      }, 20_000, 500);
      expect(body.delivery_limit).toBe(20);
      expect(body.arguments).not.toHaveProperty('x-delivery-limit');
    });

    it('the queue gives up on a Message after 20 returns that count', async (ctx) => {
      const s = await scratchFor(ctx);
      const q = await s.queue('dc-default-limit-reject', { 'x-queue-type': 'quorum' });
      await s.publish(q, ['m1']);
      let deliveries = 0;
      for (; deliveries < 30; deliveries++) {
        const m = await next(s.ch, q);
        if (!m) break;
        s.ch.reject(m, true);
        await s.check(q);
      }
      expect(deliveries).toBe(21);
    });
  });

  describe('A Message past the limit is dead-lettered with reason `delivery_limit` if the queue has a dead-letter exchange, and dropped otherwise.', () => {
    const rejectUntilGone = async (s: Scratch, q: string) => {
      for (let i = 0; i < 10; i++) {
        const m = await next(s.ch, q);
        if (!m) return;
        s.ch.reject(m, true);
        await s.check(q);
      }
      throw new Error(`${q} never gave up on the Message`);
    };

    it('with a dead-letter exchange: dead-lettered with reason delivery_limit', async (ctx) => {
      const s = await scratchFor(ctx);
      const dlq = await s.queue('dc-limit-dlq', { 'x-queue-type': 'quorum' });
      const q = await s.queue('dc-limit-dlx', {
        'x-queue-type': 'quorum',
        'x-delivery-limit': 2,
        'x-dead-letter-exchange': '',
        'x-dead-letter-routing-key': dlq,
      });
      await s.publish(q, ['poison']);
      await rejectUntilGone(s, q);
      const dead = await eventually(async () => {
        const m = await s.ch.get(dlq, { noAck: true });
        if (!m) throw new Error('not dead-lettered yet');
        return m;
      }, 3_000, 100);
      expect(dead.content.toString()).toBe('poison');
      expect(headers(dead)['x-death']).toEqual([expect.objectContaining({ reason: 'delivery_limit', queue: q, count: 1 })]);
      expect(headers(dead)['x-first-death-reason']).toBe('delivery_limit');
    });

    it('without a dead-letter exchange: dropped', async (ctx) => {
      const s = await scratchFor(ctx);
      const q = await s.queue('dc-limit-drop', { 'x-queue-type': 'quorum', 'x-delivery-limit': 2 });
      await s.publish(q, ['poison']);
      await rejectUntilGone(s, q);
      await sleep(300);
      expect(await s.check(q)).toMatchObject({ messageCount: 0 });
      expect(await s.ch.get(q)).toBe(false);
    });
  });

  describe('Peeking with the management UI\'s "ack, requeue" increases only `x-acquired-count`.', () => {
    it('Get Messages with ackmode ack_requeue_true', async (ctx) => {
      const s = await scratchFor(ctx);
      const q = await s.queue('dc-peek', { 'x-queue-type': 'quorum' });
      await s.publish(q, ['m1']);
      for (let i = 0; i < 3; i++) {
        const res = await management(`/queues/%2F/${encodeURIComponent(q)}/get`, {
          method: 'POST',
          body: { count: 1, ackmode: 'ack_requeue_true', encoding: 'auto' },
        });
        expect(res.status).toBe(200);
      }
      const m = await next(s.ch, q, 1_000, { noAck: true });
      expect(m && headers(m)).toEqual({ 'x-acquired-count': 3 });
    });
  });

  describe('Classic queues only set the `redelivered` flag.', () => {
    it.for(['nack', 'reject', 'channel-close', 'connection-close', 'recover'] as Return[])('%s', async (how, ctx) => {
      const s = await scratchFor(ctx);
      const m = await returnedOnce(s, 'classic', how);
      expect(m.fields.redelivered).toBe(true);
      expect(headers(m)).toEqual({});
    });
  });
});
