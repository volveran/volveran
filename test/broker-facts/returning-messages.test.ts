// docs/rabbitmq-behaviour.md, "Returning Messages before closing".
import { describe, expect, it } from 'vitest';
import { connect, sleep } from '../broker/client.js';
import { counts, hold, type Scratch, scratchFor } from './support.js';

type Closing = 'wait-until-ready' | 'connection' | 'channel' | 'round-trip';

const bodiesOf = (count: number) => Array.from({ length: count }, (_, i) => `m${i}`);

/** Holds every Message in `q` as a Checkout does, returns them with `nack`, and closes as `closing` says. */
async function checkOutAndReturn(q: string, count: number, closing: Closing): Promise<void> {
  const conn = await connect();
  const { ch, consumerTag, held } = await hold(conn, q, count, { arguments: { 'x-consumer-timeout': 3_600_000 } });
  await ch.cancel(consumerTag);
  for (const m of held) ch.nack(m, false, true);
  if (closing === 'round-trip') await ch.checkQueue(q);
  if (closing === 'wait-until-ready') {
    const deadline = Date.now() + 30_000;
    while ((await ch.checkQueue(q)).messageCount < count) {
      if (Date.now() > deadline) throw new Error(`the Messages did not come back to ${q}`);
      await sleep(20);
    }
  }
  if (closing !== 'connection') await ch.close();
  await conn.close();
}

/** Waits for all `count` Messages to be ready, then takes them; how many had a delivery counted, and their bodies. */
async function counted(s: Scratch, q: string, count: number): Promise<{ counted: number; bodies: string[] }> {
  const deadline = Date.now() + 30_000;
  while ((await s.check(q)).messageCount < count && Date.now() < deadline) await sleep(50);
  const out = { counted: 0, bodies: [] as string[] };
  for (;;) {
    const m = await s.ch.get(q, { noAck: true });
    if (!m) return out;
    out.bodies.push(m.content.toString());
    if (counts(m).deliveryCount !== undefined) out.counted++;
  }
}

/** Tries up to `attempts` times, since how far the `nack`s get first varies; whether any used up Delivery Budget. */
async function everCounted(s: Scratch, closing: Closing, count: number, attempts: number): Promise<boolean> {
  for (let i = 0; i < attempts; i++) {
    const q = await s.queue(`return-${closing}`, { 'x-queue-type': 'quorum' });
    await s.publish(q, bodiesOf(count));
    await checkOutAndReturn(q, count, closing);
    const result = await counted(s, q, count);
    expect(result.bodies).toEqual(bodiesOf(count));
    if (result.counted > 0) return true;
  }
  return false;
}

describe('Returning Messages before closing', () => {
  describe('`nack` with requeue uses no Delivery Budget if the channel stays open until a passive declare counts the Messages as ready, however many times they are returned.', () => {
    it('Messages survive more returns than their delivery limit, uncounted and in order', async (ctx) => {
      const s = await scratchFor(ctx);
      const q = await s.queue('return-limit', { 'x-queue-type': 'quorum', 'x-delivery-limit': 2 });
      await s.publish(q, bodiesOf(100));
      for (let i = 0; i < 5; i++) await checkOutAndReturn(q, 100, 'wait-until-ready');
      expect(await counted(s, q, 100)).toEqual({ counted: 0, bodies: bodiesOf(100) });
    });
  });

  describe('Closing the connection straight after `nack` uses up Delivery Budget on every Message.', () => {
    it('all counted, even for a few Messages', async (ctx) => {
      const s = await scratchFor(ctx);
      const q = await s.queue('return-connection', { 'x-queue-type': 'quorum' });
      await s.publish(q, bodiesOf(20));
      await checkOutAndReturn(q, 20, 'connection');
      expect(await counted(s, q, 20)).toEqual({ counted: 20, bodies: bodiesOf(20) });
    });
  });

  describe('Closing the channel straight after `nack` uses up Delivery Budget on most Messages past the first few dozen.', () => {
    it('some of 100 Messages are counted', async (ctx) => {
      const s = await scratchFor(ctx);
      expect(await everCounted(s, 'channel', 100, 5)).toBe(true);
    });
  });

  describe("A passive declare's round trip after `nack` is not enough: closing the channel then can still use up Delivery Budget.", () => {
    it('some of 200 Messages are counted', async (ctx) => {
      const s = await scratchFor(ctx);
      expect(await everCounted(s, 'round-trip', 200, 10)).toBe(true);
    });
  });
});
