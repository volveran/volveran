// docs/rabbitmq-behaviour.md, "Queue counts". The management API figures
// come from statistics the broker emits every 5 s (RabbitMQ's default
// collect_statistics_interval, kept in test/broker/rabbitmq.conf).
import { describe, expect, it } from 'vitest';
import { eventually, management } from '../broker/client.js';
import { hold, type Scratch, scratchFor } from './support.js';

/** The queue's management API details, once the API lists the queue. */
async function managementDetails(q: string): Promise<any> {
  return eventually(async () => {
    const res = await management(`/queues/%2F/${encodeURIComponent(q)}`);
    if (res.status !== 200 || res.body.messages === undefined) throw new Error(`${q} not in the management API yet`);
    return res.body;
  }, 20_000, 250);
}

/**
 * Runs `scenario` on fresh quorum queues until it sees the management API
 * stale right after a change. A statistics emission can land between the
 * change and the read by chance (about 1 in 50), so a few tries are allowed.
 */
async function seenStale(s: Scratch, prefix: string, scenario: (q: string) => Promise<boolean>): Promise<boolean> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const q = await s.queue(`${prefix}-${attempt}`, { 'x-queue-type': 'quorum' });
    await managementDetails(q);
    if (await scenario(q)) return true;
  }
  return false;
}

describe.concurrent('Queue counts', () => {
  describe('Management API counts lag a confirmed publish by roughly 4–9 seconds. The API can also show 0 consumers on a quorum queue that has one.', () => {
    it('right after a confirmed publish the management API still shows the old count, and catches up within seconds', async (ctx) => {
      const s = await scratchFor(ctx);
      let caughtUpAfterMs = 0;
      const stale = await seenStale(s, 'qc-lag', async (q) => {
        await s.publish(q, Array.from({ length: 50 }, (_, i) => `m${i}`));
        const confirmedAt = Date.now();
        const right = await management(`/queues/%2F/${encodeURIComponent(q)}`);
        if (right.body.messages === 50) return false;
        await eventually(async () => {
          expect((await management(`/queues/%2F/${encodeURIComponent(q)}`)).body.messages).toBe(50);
        }, 15_000, 100);
        caughtUpAfterMs = Date.now() - confirmedAt;
        return true;
      });
      expect(stale).toBe(true);
      expect(caughtUpAfterMs).toBeGreaterThan(0);
      expect(caughtUpAfterMs).toBeLessThan(15_000);
      ctx.annotate(`management API caught up ${caughtUpAfterMs} ms after the confirm`);
    });

    it('the management API shows 0 consumers on a quorum queue that has one', async (ctx) => {
      const s = await scratchFor(ctx);
      const stale = await seenStale(s, 'qc-consumers', async (q) => {
        await s.publish(q, ['m1']);
        await hold(s.conn, q, 1);
        const { consumerCount } = await s.check(q);
        const shown = (await management(`/queues/%2F/${encodeURIComponent(q)}`)).body.consumers;
        return consumerCount === 1 && shown === 0;
      });
      expect(stale).toBe(true);
    });
  });

  describe('A passive `queue.declare` returns exact counts at once. Its `message_count` counts ready Messages only, not unacknowledged ones.', () => {
    it.for(['classic', 'quorum'] as const)('%s', async (type, ctx) => {
      const s = await scratchFor(ctx);
      const q = await s.queue(`qc-passive-${type}`, { 'x-queue-type': type });
      await s.publish(q, Array.from({ length: 50 }, (_, i) => `m${i}`));
      expect(await s.check(q)).toMatchObject({ messageCount: 50, consumerCount: 0 });

      await hold(s.conn, q, 20);
      expect(await s.check(q)).toMatchObject({ messageCount: 30, consumerCount: 1 });
    });
  });
});
