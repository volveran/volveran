// docs/rabbitmq-behaviour.md, "Publishing".
import { describe, expect, it } from 'vitest';
import { openChannel, openConfirmChannel, uniqueName } from '../broker/client.js';
import { hold, queueTypes, scratchFor, within } from './support.js';

describe.concurrent('Publishing', () => {
  describe('Publishing to a missing exchange closes only that channel (`404 NOT_FOUND`). Other channels on the connection keep their unacknowledged deliveries.', () => {
    it.for(queueTypes)('%s', async (type, ctx) => {
      const s = await scratchFor(ctx);
      const q = await s.queue(`pub-missing-${type}`, { 'x-queue-type': type });
      await s.publish(q, ['m1', 'm2']);
      const holder = await hold(s.conn, q, 2);

      const pub = await openChannel(s.conn);
      const closed = new Promise<Error>((resolve) => pub.on('error', resolve));
      pub.publish(uniqueName('no-such-exchange'), 'rk', Buffer.from('x'));
      const err = await within(closed, 3_000);
      expect(err).not.toBe('nothing');
      expect((err as Error).message).toMatch(/404 \(NOT-FOUND\).*no exchange/);

      expect(await within(holder.channelError, 300)).toBe('nothing');
      expect(await s.check(q)).toMatchObject({ messageCount: 0, consumerCount: 1 });
      // The holding channel still works: its acks are honoured.
      for (const m of holder.held) holder.ch.ack(m);
      await holder.ch.checkQueue(q);
      await holder.ch.close();
      expect(await s.check(q)).toMatchObject({ messageCount: 0 });
    });
  });

  describe('With publisher confirms and `mandatory`, an unroutable Message gets `basic.return` (`312 NO_ROUTE`) and then a confirm (`ack`), not a `nack`.', () => {
    it('basic.return arrives first, then the publish is acked', async (ctx) => {
      const s = await scratchFor(ctx);
      const ch = await openConfirmChannel(s.conn);
      const events: string[] = [];
      ch.on('return', (m: { fields: { replyCode: number; replyText: string } }) =>
        events.push(`return ${m.fields.replyCode} ${m.fields.replyText}`),
      );
      const confirm = await new Promise<string>((resolve) =>
        ch.publish('amq.direct', uniqueName('nobody-bound'), Buffer.from('x'), { mandatory: true }, (err) =>
          resolve(err ? 'nack' : 'ack'),
        ),
      );
      events.push(confirm);
      expect(events).toEqual(['return 312 NO_ROUTE', 'ack']);
    });
  });
});
