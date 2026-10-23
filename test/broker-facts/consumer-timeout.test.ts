// docs/rabbitmq-behaviour.md, "Consumer timeout". The tests wait out real
// timeouts, so they run concurrently; each uses its own queues.
import { describe, expect, it } from 'vitest';
import { eventually, management, sleep, testBroker } from '../broker/client.js';
import { hold, refusal, scratchFor, within } from './support.js';

/** A quorum consumer timeout short enough to wait out. */
const SHORT = 2_000;

describe.concurrent('Consumer timeout', () => {
  describe('Classic queues no longer time out consumers. `x-consumer-timeout` is rejected on them.', () => {
    it('a classic consumer holding Messages past the global consumer_timeout is not cancelled', async (ctx) => {
      const s = await scratchFor(ctx);
      const q = await s.queue('ct-classic', { 'x-queue-type': 'classic' });
      await s.publish(q, ['m1', 'm2']);
      const holder = await hold(s.conn, q, 2);

      const outcome = await within(Promise.race([holder.brokerCancel, holder.channelError]), testBroker.consumerTimeoutMs + 3_000);

      expect(outcome).toBe('nothing');
      expect(await s.check(q)).toMatchObject({ messageCount: 0, consumerCount: 1 });
    });

    it('x-consumer-timeout as a classic queue argument is refused', async (ctx) => {
      const s = await scratchFor(ctx);
      const ch = await s.conn.createChannel();
      ch.on('error', () => {});
      const name = `facts.ct-classic-arg.${Date.now()}`;
      expect(await refusal(ch.assertQueue(name, { arguments: { 'x-queue-type': 'classic', 'x-consumer-timeout': SHORT } }))).toMatch(
        /406 \(PRECONDITION-FAILED\).*invalid arg 'x-consumer-timeout'/,
      );
    });

    it('x-consumer-timeout as a consumer argument on a classic queue is refused', async (ctx) => {
      const s = await scratchFor(ctx);
      const q = await s.queue('ct-classic-carg', { 'x-queue-type': 'classic' });
      const ch = await s.conn.createChannel();
      ch.on('error', () => {});
      expect(await refusal(ch.consume(q, () => {}, { arguments: { 'x-consumer-timeout': SHORT } }))).toMatch(
        /406 \(PRECONDITION-FAILED\).*invalid arg 'x-consumer-timeout'/,
      );
    });
  });

  describe('Quorum queues send `basic.cancel` when a consumer\'s timeout passes. The channel stays open, the Messages become ready again, and later acks or nacks of their delivery tags are silently ignored.', () => {
    it('cancels the consumer, keeps the channel open, makes the Messages ready and ignores later acks and nacks', async (ctx) => {
      const s = await scratchFor(ctx);
      const q = await s.queue('ct-quorum', { 'x-queue-type': 'quorum' });
      await s.publish(q, ['m1', 'm2', 'm3']);
      const holder = await hold(s.conn, q, 3, { arguments: { 'x-consumer-timeout': SHORT } });

      const cancelledAt = await within(holder.brokerCancel, SHORT + 3_000);
      expect(cancelledAt).not.toBe('nothing');
      expect((cancelledAt as number) - holder.startedAt).toBeGreaterThanOrEqual(SHORT - 500);
      await sleep(300);
      expect(await s.check(q)).toMatchObject({ messageCount: 3 });

      const [m1, m2] = holder.held;
      holder.ch.ack(m1!);
      holder.ch.nack(m2!, false, false);
      // The channel is still open: a round trip on it succeeds.
      await holder.ch.checkQueue(q);
      expect(await within(holder.channelError, 300)).toBe('nothing');
      expect(await s.check(q)).toMatchObject({ messageCount: 3 });
      expect(await s.bodies(q)).toEqual(['m1', 'm2', 'm3']);
    });
  });

  describe('On quorum queues the timeout can be set by consumer argument, queue argument or policy (`consumer-timeout`). The consumer argument wins.', () => {
    it('a queue argument sets the timeout', async (ctx) => {
      const s = await scratchFor(ctx);
      const q = await s.queue('ct-qarg', { 'x-queue-type': 'quorum', 'x-consumer-timeout': SHORT });
      await s.publish(q, ['m1']);
      const holder = await hold(s.conn, q, 1);
      expect(await within(holder.brokerCancel, SHORT + 3_000)).not.toBe('nothing');
    });

    it('a policy sets the timeout', async (ctx) => {
      const s = await scratchFor(ctx);
      const q = await s.queue('ct-policy', { 'x-queue-type': 'quorum' });
      const policy = `/policies/%2F/${encodeURIComponent(q)}`;
      const put = await management(policy, {
        method: 'PUT',
        body: { pattern: `^${q.replace(/\./g, '\\.')}$`, definition: { 'consumer-timeout': SHORT }, 'apply-to': 'queues' },
      });
      expect(put.status).toBeLessThan(300);
      try {
        await eventually(async () => {
          const { body } = await management(`/queues/%2F/${encodeURIComponent(q)}`);
          expect(body.effective_policy_definition).toMatchObject({ 'consumer-timeout': SHORT });
        });
        await s.publish(q, ['m1']);
        const holder = await hold(s.conn, q, 1);
        expect(await within(holder.brokerCancel, SHORT + 3_000)).not.toBe('nothing');
      } finally {
        await management(policy, { method: 'DELETE' });
      }
    });

    it('the consumer argument wins over a shorter queue argument', async (ctx) => {
      const s = await scratchFor(ctx);
      const q = await s.queue('ct-carg-wins', { 'x-queue-type': 'quorum', 'x-consumer-timeout': 1_000 });
      await s.publish(q, ['m1']);
      const holder = await hold(s.conn, q, 1, { arguments: { 'x-consumer-timeout': 5_000 } });
      const cancelledAt = await within(holder.brokerCancel, 9_000);
      expect(cancelledAt).not.toBe('nothing');
      expect((cancelledAt as number) - holder.startedAt).toBeGreaterThanOrEqual(4_500);
    });

    it('the consumer argument wins over a longer queue argument', async (ctx) => {
      const s = await scratchFor(ctx);
      const q = await s.queue('ct-carg-shorter', { 'x-queue-type': 'quorum', 'x-consumer-timeout': 60_000 });
      await s.publish(q, ['m1']);
      const holder = await hold(s.conn, q, 1, { arguments: { 'x-consumer-timeout': SHORT } });
      expect(await within(holder.brokerCancel, SHORT + 3_000)).not.toBe('nothing');
    });
  });

  describe('The management API\'s `/api/consumers` `consumer_timeout` field does not reflect the consumer argument, and is shown for classic consumers too.', () => {
    const consumerTimeoutShown = (q: string) =>
      eventually(async () => {
        const consumers = (await management('/consumers/%2F')).body as Array<{ queue: { name: string }; consumer_timeout?: number }>;
        const mine = consumers.find((c) => c.queue.name === q);
        if (!mine) throw new Error(`no consumer of ${q} listed yet`);
        return mine.consumer_timeout;
      }, 20_000, 500);

    it('a quorum consumer with x-consumer-timeout is listed with the global consumer_timeout', async (ctx) => {
      const s = await scratchFor(ctx);
      const q = await s.queue('ct-mgmt-quorum', { 'x-queue-type': 'quorum' });
      await s.publish(q, ['m1']);
      await hold(s.conn, q, 1, { arguments: { 'x-consumer-timeout': 50_000 } });
      expect(await consumerTimeoutShown(q)).toBe(testBroker.consumerTimeoutMs);
    });

    it('a classic consumer is listed with a consumer_timeout', async (ctx) => {
      const s = await scratchFor(ctx);
      const q = await s.queue('ct-mgmt-classic', { 'x-queue-type': 'classic' });
      await s.publish(q, ['m1']);
      await hold(s.conn, q, 1);
      expect(await consumerTimeoutShown(q)).toBe(testBroker.consumerTimeoutMs);
    });
  });

  // Not a bullet of docs/rabbitmq-behaviour.md yet: ADR 0006 cancels the
  // Checkout's consumer once it holds N deliveries, and relies on the quorum
  // consumer timeout as a backstop. This pins down what the broker does then.
  describe('Quorum timeout after the client cancelled its own consumer (ADR 0006 backstop)', () => {
    it('still fires: the broker closes the channel with 406 PRECONDITION_FAILED, sends no basic.cancel, and requeues the Messages without counting a delivery', async (ctx) => {
      const s = await scratchFor(ctx);
      const q = await s.queue('ct-after-cancel', { 'x-queue-type': 'quorum' });
      await s.publish(q, ['m1', 'm2', 'm3']);
      const holder = await hold(s.conn, q, 3, { arguments: { 'x-consumer-timeout': SHORT } });
      await holder.ch.cancel(holder.consumerTag);
      // The quorum queue keeps counting the cancelled consumer while it has unacked deliveries.
      expect(await s.check(q)).toMatchObject({ messageCount: 0, consumerCount: 1 });

      const err = await within(holder.channelError, SHORT + 3_000);
      expect(err).not.toBe('nothing');
      expect((err as Error).message).toMatch(/406 \(PRECONDITION-FAILED\).*delivery acknowledgement on channel \d+ timed out/);
      expect(await within(holder.brokerCancel, 0)).toBe('nothing');

      await sleep(300);
      expect(await s.check(q)).toMatchObject({ messageCount: 3, consumerCount: 0 });
      const m = await s.ch.get(q, { noAck: true });
      expect(m && m.content.toString()).toBe('m1');
      expect(m && m.properties.headers?.['x-delivery-count']).toBeUndefined();
      expect(m && m.properties.headers?.['x-acquired-count']).toBe(1);
    });

    it('the global consumer_timeout applies the same way when no x-consumer-timeout is set', async (ctx) => {
      const s = await scratchFor(ctx);
      const q = await s.queue('ct-after-cancel-global', { 'x-queue-type': 'quorum' });
      await s.publish(q, ['m1']);
      const holder = await hold(s.conn, q, 1);
      await holder.ch.cancel(holder.consumerTag);
      const err = await within(holder.channelError, testBroker.consumerTimeoutMs + 3_000);
      expect(err).not.toBe('nothing');
      expect((err as Error).message).toMatch(/406 \(PRECONDITION-FAILED\).*timed out/);
      await sleep(300);
      expect(await s.check(q)).toMatchObject({ messageCount: 1, consumerCount: 0 });
    });

    it('classic queues keep holding the Messages of a cancelled consumer past the global consumer_timeout', async (ctx) => {
      const s = await scratchFor(ctx);
      const q = await s.queue('ct-after-cancel-classic', { 'x-queue-type': 'classic' });
      await s.publish(q, ['m1']);
      const holder = await hold(s.conn, q, 1);
      await holder.ch.cancel(holder.consumerTag);
      expect(await within(holder.channelError, testBroker.consumerTimeoutMs + 3_000)).toBe('nothing');
      expect(await s.check(q)).toMatchObject({ messageCount: 0, consumerCount: 0 });
    });
  });
});
