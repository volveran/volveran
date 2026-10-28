// Died Again through the HTTP API, against the real broker: a Message that
// Volverán Replayed, Moved or Restored and whose consumer rejected it again is
// flagged in the next Checkout, linked to the Audit Entry that sent it out,
// with how many times it has died again (followed through the replay ids the
// earlier Audit Entries recorded).
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  applyAndWait,
  deadLetter,
  deadLetterRoutes,
  fixtureQueues,
  purgeQueues,
  startApp,
  testOperator,
  testProfile,
  withChannel,
  type TestApp,
} from './harness.js';

const route = deadLetterRoutes.classic;
const checkoutPath = (queue: string) => `/api/profiles/local/vhosts/%2F/queues/${encodeURIComponent(queue)}/checkouts`;
const REPLAY = { kind: 'replay' };

describe('Died Again', () => {
  let app: TestApp;
  const open: string[] = [];

  async function startCheckout(queue = route.dlq) {
    const res = await app.post(checkoutPath(queue));
    expect(res.status).toBe(201);
    const checkout = res.body.checkout;
    open.push(checkout.id);
    const message = (messageId: string) => checkout.messages.find((m: any) => m.messageId === messageId);
    return { id: checkout.id as string, checkout, message, handle: (messageId: string) => message(messageId).handle as number };
  }
  const decide = (id: string, handles: number[], decision: unknown) =>
    app.post(`/api/checkouts/${id}/decisions`, { handles, decision });
  async function apply(id: string) {
    const res = await applyAndWait(app, `/api/checkouts/${id}/apply`, { confirm: true });
    expect(res.status).toBe(202);
    return res.body;
  }
  /** The Audit Entries of a Checkout's Apply, newest first. */
  const entriesOf = async (checkoutId: string) => (await app.get(`/api/audit-entries?checkoutId=${checkoutId}`)).body.entries;

  /** Gives `messageId` a Decision in a Checkout of the DLQ and Applies it; returns that Apply's Audit Entry. */
  async function sendOut(messageId: string, decision: unknown) {
    const { id, handle } = await startCheckout();
    expect((await decide(id, [handle(messageId)], decision)).status).toBe(200);
    await apply(id);
    open.splice(open.indexOf(id), 1);
    const [entry] = await entriesOf(id);
    return entry;
  }

  /** The consumer of `queue` rejects every ready Message, so the broker dead-letters them again. */
  async function rejectAll(queue = route.workQueue) {
    await withChannel('/', async (ch) => {
      for (;;) {
        const m = await ch.get(queue, { noAck: false });
        if (!m) break;
        ch.nack(m, false, false);
      }
    });
    // Only the DLQ the test reads matters; the fanout copies elsewhere would be checked out by nobody.
    await purgeQueues('/', route.dlqs.filter((q) => q !== route.dlq));
  }

  beforeAll(async () => {
    app = await startApp({ profiles: [testProfile({ name: 'local' })] });
  });
  afterEach(async () => {
    while (open.length) await app.delete(`/api/checkouts/${open.pop()}`);
    await purgeQueues('/', fixtureQueues);
  });
  afterAll(async () => {
    await app?.close();
  });

  it('flags a Replayed Message that was dead-lettered again, with count 1 and the Replay\'s Audit Entry', async () => {
    await deadLetter(route, [{ body: 'poison', options: { messageId: 'p-1' } }, { body: 'fine', options: { messageId: 'f-1' } }]);
    await purgeQueues('/', route.dlqs.filter((q) => q !== route.dlq));
    const replay = await sendOut('p-1', REPLAY);
    await rejectAll();

    const { message } = await startCheckout();

    expect(message('p-1').diedAgain).toEqual({
      replayId: replay.replayId,
      count: 1,
      last: {
        auditEntryId: replay.id,
        action: 'replay',
        at: replay.at,
        operatorName: testOperator,
        fromQueue: route.dlq,
      },
    });
    expect(message('f-1').diedAgain).toBeNull();
  });

  it('counts 2 after a second round trip, following the chain through the earlier Audit Entry', async () => {
    await deadLetter(route, [{ body: 'poison', options: { messageId: 'p-2' } }]);
    await purgeQueues('/', route.dlqs.filter((q) => q !== route.dlq));
    await sendOut('p-2', REPLAY);
    await rejectAll();
    const second = await sendOut('p-2', REPLAY);
    await rejectAll();

    const { id, handle, message } = await startCheckout();

    expect(message('p-2').diedAgain).toMatchObject({ replayId: second.replayId, count: 2, last: { auditEntryId: second.id } });
    // The Message view says the same.
    const view = await app.get(`/api/checkouts/${id}/messages/${handle('p-2')}`);
    expect(view.body.message.diedAgain).toEqual(message('p-2').diedAgain);
  });

  it('flags a Moved Message that comes back', async () => {
    await deadLetter(route, [{ body: 'poison', options: { messageId: 'm-1' } }]);
    await purgeQueues('/', route.dlqs.filter((q) => q !== route.dlq));
    const move = await sendOut('m-1', { kind: 'move', destination: { queue: route.workQueue } });
    await rejectAll();

    const { message } = await startCheckout();

    expect(message('m-1').diedAgain).toMatchObject({ count: 1, last: { auditEntryId: move.id, action: 'move', fromQueue: route.dlq } });
  });

  it('flags a Restored Message that comes back, counting the trip before its Discard', async () => {
    await deadLetter(route, [{ body: 'poison', options: { messageId: 'r-1' } }]);
    await purgeQueues('/', route.dlqs.filter((q) => q !== route.dlq));
    await sendOut('r-1', REPLAY);
    await rejectAll();
    const discard = await sendOut('r-1', { kind: 'discard', reason: 'looked broken' });
    const restored = await app.post(`/api/audit-entries/${discard.id}/restore`, { confirm: true, queue: route.workQueue });
    expect(restored.status).toBe(200);
    await rejectAll();

    const { message } = await startCheckout();

    expect(message('r-1').diedAgain).toMatchObject({
      replayId: restored.body.entry.replayId,
      count: 2,
      last: { auditEntryId: restored.body.entry.id, action: 'restore', fromQueue: route.dlq },
    });
  });

  it('flags a Message whose replay id has no Audit Entry here, with no entry', async () => {
    await withChannel('/', async (ch) => {
      ch.sendToQueue(route.dlq, Buffer.from('elsewhere'), {
        messageId: 'u-1',
        headers: { 'x-volveran-replay-id': 'replayed-by-another-instance' },
      });
      await ch.waitForConfirms();
    });

    const { message } = await startCheckout();

    expect(message('u-1').diedAgain).toEqual({ replayId: 'replayed-by-another-instance', count: 1, last: null });
  });

  it('selects exactly the Died Again Messages with the died-again filter, as many as the summary counts', async () => {
    await deadLetter(route, [
      { body: 'poison', options: { messageId: 'a' } },
      { body: 'fine', options: { messageId: 'b' } },
      { body: 'poison', options: { messageId: 'c' } },
    ]);
    await purgeQueues('/', route.dlqs.filter((q) => q !== route.dlq));
    const first = await startCheckout();
    await decide(first.id, [first.handle('a'), first.handle('c')], REPLAY);
    await apply(first.id);
    open.splice(open.indexOf(first.id), 1);
    await rejectAll();

    const { id, checkout, handle } = await startCheckout();
    const matching = await app.post(`/api/checkouts/${id}/matching`, { filter: [{ kind: 'died-again' }] });

    expect(matching.status).toBe(200);
    expect(matching.body.handles.sort()).toEqual([handle('a'), handle('c')].sort());
    expect(checkout.diedAgainCount).toBe(2);
    expect(matching.body.count).toBe(checkout.diedAgainCount);
  });
});
