// Guards the test broker topology later tickets rely on: dead-lettered
// Messages land in every DLQ of their route with a real x-death header.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  deadLetter,
  deadLetterRoutes,
  eventually,
  fixtureQueues,
  management,
  purgeQueues,
  withChannel,
} from './harness.js';

describe('test broker topology', () => {
  beforeEach(() => purgeQueues('/', fixtureQueues));
  afterEach(() => purgeQueues('/', fixtureQueues));

  const cases = Object.entries(deadLetterRoutes).flatMap(([kind, route]) =>
    route.dlqs.map((dlq) => ({ kind, route, dlq })),
  );

  it.each(cases)('dead-letters $kind Messages into $dlq with x-death', async ({ route, dlq }) => {
    await deadLetter(route, [{ body: '{"id":1}', options: { messageId: 'm-1', contentType: 'application/json' } }]);

    const msg = await withChannel(route.vhost, (ch) =>
      eventually(async () => {
        const got = await ch.get(dlq, { noAck: true });
        if (!got) throw new Error(`nothing arrived in ${dlq}`);
        return got;
      }, 4_000, 100),
    );

    expect(msg.properties.messageId).toBe('m-1');
    expect(msg.fields.routingKey).toBe(route.routingKey);
    const xDeath: unknown[] = msg.properties.headers?.['x-death'] ?? [];
    expect(xDeath).toHaveLength(1);
    expect(xDeath[0]).toMatchObject({
      queue: route.workQueue,
      reason: 'rejected',
      exchange: route.exchange,
      'routing-keys': [route.routingKey],
    });
  });

  it('has quorum DLQs with the default delivery-limit both with and without a dead-letter exchange', async () => {
    const { body: withoutDlx } = await management('/queues/%2F/orders.dlq.quorum');
    const { body: withDlx } = await management('/queues/%2F/orders.dlq.quorum-dlx');
    expect(withoutDlx).toMatchObject({ type: 'quorum', delivery_limit: 20 });
    expect(withoutDlx.arguments).not.toHaveProperty('x-dead-letter-exchange');
    expect(withDlx).toMatchObject({ type: 'quorum', delivery_limit: 20 });
    expect(withDlx.arguments).toMatchObject({ 'x-dead-letter-exchange': 'orders.dlq.dlx' });
  });
});
