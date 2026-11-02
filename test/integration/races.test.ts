// Races between a starting Checkout and the broker or another instance,
// driven deterministically through the Checkout manager's test hooks.
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { storeSpeeds } from '../support/delayed-audit-store.js';
import {
  checkoutConnectionNames,
  closeConnection,
  eventually,
  purgeQueues,
  readyMessageIds,
  seedMessages,
  startApp,
  testOperator,
  testProfile,
  type TestApp,
} from './harness.js';

const QUEUE = 'orders.dlq';
const checkoutPath = `/api/profiles/local/vhosts/%2F/queues/${QUEUE}/checkouts`;

type Hook = (() => Promise<void>) | null;

describe.each(storeSpeeds)('races (%s)', (_speed, wrapAuditStore) => {
  let app: TestApp;
  let afterLock: Hook = null;
  let afterCollectWait: Hook = null;

  async function dropCheckoutConnection() {
    const names = await eventually(async () => {
      const found = await checkoutConnectionNames(QUEUE);
      expect(found.length).toBeGreaterThan(0);
      return found;
    });
    for (const name of names) await closeConnection(name);
  }

  beforeAll(async () => {
    app = await startApp({
      profiles: [testProfile({ name: 'local' })],
      wrapAuditStore,
      checkoutTestHooks: {
        afterLock: async () => afterLock?.(),
        afterCollectWait: async () => afterCollectWait?.(),
      },
    });
  });
  afterEach(async () => {
    afterLock = null;
    afterCollectWait = null;
    await eventually(async () => expect(await checkoutConnectionNames(QUEUE)).toEqual([]));
    await purgeQueues('/', [QUEUE]);
  });
  afterAll(async () => {
    await app?.close();
  });

  it('refuses a start on another instance while the first holds the lock queue but has not collected yet', async () => {
    await seedMessages('/', QUEUE, 2);
    const other = await startApp({ profiles: [testProfile({ name: 'local' })], env: { VOLVERAN_OPERATOR: 'bob' } });
    let refused: { status: number; body: any } | undefined;
    afterLock = async () => {
      afterLock = null;
      refused = await other.post(checkoutPath);
    };
    try {
      const first = await app.post(checkoutPath);

      expect(first.status).toBe(201);
      expect(first.body.checkout.heldCount).toBe(2);
      expect(refused?.status).toBe(409);
      expect(refused?.body.error).toMatchObject({
        code: 'checkout_in_progress',
        holder: { operator: testOperator, since: first.body.checkout.startedAt },
      });
      await app.delete(`/api/checkouts/${first.body.checkout.id}`);
    } finally {
      await other.close();
    }
  });

  it('fails a start whose connection drops after collecting with 502 checkout_failed, and frees queue and Operator', async () => {
    await seedMessages('/', QUEUE, 2);
    afterCollectWait = async () => {
      afterCollectWait = null;
      await dropCheckoutConnection();
      await eventually(async () => expect(await checkoutConnectionNames(QUEUE)).toEqual([]));
    };

    const res = await app.post(checkoutPath);

    expect([res.status, res.body.error?.code]).toEqual([502, 'checkout_failed']);
    expect(res.body.error.message).toMatch(/closed/);
    expect(await eventually(async () => {
      const ids = await readyMessageIds('/', QUEUE);
      expect(ids).toHaveLength(2);
      return ids.sort();
    })).toEqual([`${QUEUE}-0`, `${QUEUE}-1`]);
    expect((await app.get('/api/session')).body.checkoutId).toBeNull();
    // The broker deletes the lock queue of the closed connection a moment after the close.
    const again = await eventually(async () => {
      const started = await app.post(checkoutPath);
      expect(started.status).toBe(201);
      return started;
    });
    await app.delete(`/api/checkouts/${again.body.checkout.id}`);
  });
});
