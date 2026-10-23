// Protected Profiles through the HTTP API: on a Protected Profile, an Apply
// with any Decision other than Keep needs the queue name typed, enforced by
// the server; a refused Apply leaves the broker untouched.
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { purgeQueues, readyMessageIds, seedMessages, startApp, testProfile, type TestApp } from './harness.js';

const checkoutPath = (profile: string, queue: string) =>
  `/api/profiles/${profile}/vhosts/%2F/queues/${encodeURIComponent(queue)}/checkouts`;
const DISCARD = { kind: 'discard', reason: 'bad payload' };
const QUEUE = 'orders.dlq';

describe('Protected Profiles', () => {
  let app: TestApp;
  const open: string[] = [];

  async function startCheckout(profile: string) {
    const res = await app.post(checkoutPath(profile, QUEUE));
    expect(res.status).toBe(201);
    open.push(res.body.checkout.id);
    const checkout = res.body.checkout;
    const handle = (messageId: string): number => checkout.messages.find((m: any) => m.messageId === messageId).handle;
    return { id: checkout.id as string, checkout, handle };
  }

  async function checkoutWithDiscard(profile: string) {
    const started = await startCheckout(profile);
    const decided = await app.post(`/api/checkouts/${started.id}/decisions`, {
      handles: [started.handle(`${QUEUE}-0`)],
      decision: DISCARD,
    });
    expect(decided.status).toBe(200);
    return { id: started.id, checkout: decided.body.checkout };
  }

  const apply = (id: string, body: unknown) => app.post(`/api/checkouts/${id}/apply`, body);

  beforeAll(async () => {
    app = await startApp({
      profiles: [testProfile({ name: 'prod', protected: true }), testProfile({ name: 'dev', protected: false })],
    });
  });
  afterEach(async () => {
    while (open.length) await app.delete(`/api/checkouts/${open.pop()}`);
    await purgeQueues('/', [QUEUE]);
  });
  afterAll(async () => {
    await app?.close();
  });

  it('rejects an Apply without or with a wrong typed queue name, changing nothing, and accepts the correct one', async () => {
    await seedMessages('/', QUEUE, 2);
    const { id, checkout } = await checkoutWithDiscard('prod');
    expect(checkout.protectedProfile).toBe(true);
    expect(checkout.applyConfirmation).toEqual({ typeQueueName: true });

    for (const confirmQueueName of [undefined, 'orders.dl', 'ORDERS.DLQ', ` ${QUEUE}`]) {
      const refused = await apply(id, { confirm: true, confirmQueueName });
      expect([refused.status, refused.body.error.code]).toEqual([400, 'queue_name_confirmation_required']);
      expect(refused.body.error.message).toContain(QUEUE);
      expect(refused.body.error.message).toContain('prod');
    }
    // Nothing changed: the Checkout still holds both Messages, the queue has none ready.
    const after = (await app.get(`/api/checkouts/${id}`)).body.checkout;
    expect([after.status, after.heldCount]).toEqual(['active', 2]);
    expect(await readyMessageIds('/', QUEUE)).toEqual([]);

    const ok = await apply(id, { confirm: true, confirmQueueName: QUEUE });
    expect(ok.status).toBe(200);
    expect(ok.body.outcomes).toEqual(
      expect.arrayContaining([expect.objectContaining({ messageId: `${QUEUE}-0`, status: 'done' })]),
    );
    expect(await readyMessageIds('/', QUEUE)).toEqual([`${QUEUE}-1`]);
  });

  it('still needs the single confirmation on a Protected Profile', async () => {
    await seedMessages('/', QUEUE, 1);
    const { id } = await checkoutWithDiscard('prod');
    const res = await apply(id, { confirmQueueName: QUEUE });
    expect([res.status, res.body.error.code]).toEqual([400, 'confirmation_required']);
  });

  it('needs no typed queue name for an Apply with only Keep Decisions', async () => {
    await seedMessages('/', QUEUE, 2);
    const { id, checkout } = await startCheckout('prod');
    expect(checkout.applyConfirmation).toEqual({ typeQueueName: false });

    const ok = await apply(id, { confirm: true });
    expect(ok.status).toBe(200);
    expect(await readyMessageIds('/', QUEUE)).toEqual([`${QUEUE}-0`, `${QUEUE}-1`]);
  });

  it('keeps the single confirmation on a profile that is not protected', async () => {
    await seedMessages('/', QUEUE, 2);
    const { id, checkout } = await checkoutWithDiscard('dev');
    expect(checkout.protectedProfile).toBe(false);
    expect(checkout.applyConfirmation).toEqual({ typeQueueName: false });

    const ok = await apply(id, { confirm: true });
    expect(ok.status).toBe(200);
    expect(await readyMessageIds('/', QUEUE)).toEqual([`${QUEUE}-1`]);
  });
});
