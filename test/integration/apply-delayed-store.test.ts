// An Apply on a store that takes its time (ADR 0013), against the real broker: a
// store call is an interleave point, where a stop or a Lost Checkout can land.
// ADR 0001's order still holds, and the first of a stop and the last step still wins.
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { delayedAuditStore } from '../support/delayed-audit-store.js';
import {
  appliedCheckout,
  checkoutConnectionNames,
  closeConnection,
  eventually,
  purgeQueues,
  readyMessageIds,
  seedMessages,
  startApp,
  testOperator,
  testProfile,
  uniqueName,
  withChannel,
  type TestApp,
} from './harness.js';

const QUEUE = 'orders.dlq';
const DISCARD = { kind: 'discard', reason: 'bad payload' };
const ids = (...n: number[]) => n.map((i) => `${QUEUE}-${i}`);

describe('An Apply on a delayed store', () => {
  let app: TestApp;
  /** Holds calls of this name until released; `reached` resolves when one arrives. */
  let held: { call: string; reached: () => void; released: Promise<void>; release: () => void } | null = null;
  let beforeApplyStep: ((entryId: number) => Promise<void>) | null = null;

  function hold(call: string) {
    let release!: () => void;
    let reached!: () => void;
    const released = new Promise<void>((resolve) => (release = resolve));
    const arrived = new Promise<void>((resolve) => (reached = resolve));
    held = { call, reached, released, release };
    return { arrived, release };
  }

  async function checkoutWith(decision: unknown, seeded: number, decided = seeded) {
    await seedMessages('/', QUEUE, seeded);
    const started = await app.post(`/api/profiles/local/vhosts/%2F/queues/${QUEUE}/checkouts`);
    expect(started.status).toBe(201);
    const { id, messages } = started.body.checkout;
    const handles = messages.slice(0, decided).map((m: any) => m.handle);
    expect((await app.post(`/api/checkouts/${id}/decisions`, { handles, decision })).status).toBe(200);
    return id as string;
  }
  const startApply = async (id: string) => expect((await app.post(`/api/checkouts/${id}/apply`, { confirm: true })).status).toBe(202);
  const entries = async (id: string) => (await app.get(`/api/audit-entries?checkoutId=${id}`)).body.entries as any[];
  const outcomes = (checkout: any) => checkout.lastApply.outcomes.map((o: any) => [o.messageId, o.status]);

  async function loseCheckout(id: string) {
    // The management API lists a new connection within a second or so.
    const names = await eventually(async () => {
      const found = await checkoutConnectionNames(QUEUE);
      expect(found.length).toBeGreaterThan(0);
      return found;
    });
    for (const name of names) await closeConnection(name);
    await eventually(async () => expect((await app.get(`/api/checkouts/${id}`)).body.checkout.status).toBe('lost'));
  }

  beforeAll(async () => {
    app = await startApp({
      profiles: [testProfile({ name: 'local' })],
      wrapAuditStore: (store) =>
        delayedAuditStore(store, async (call) => {
          if (held?.call !== call) return;
          held.reached();
          await held.released;
        }),
      checkoutTestHooks: { beforeApplyStep: async (entryId) => beforeApplyStep?.(entryId) },
    });
  });
  afterEach(async () => {
    // A test that failed part way must not leave its Apply waiting on the store.
    held?.release();
    held = null;
    beforeApplyStep = null;
    await eventually(async () => expect(await checkoutConnectionNames(QUEUE)).toEqual([]));
    await purgeQueues('/', [QUEUE]);
  });
  afterAll(async () => {
    await app?.close();
  });

  it('gives an export the Messages it started with when an Apply starts during its first store call', async () => {
    const id = await checkoutWith(DISCARD, 2);
    const { arrived, release } = hold('record');
    const exporting = fetch(`${app.baseUrl}/api/checkouts/${id}/export`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    await arrived;

    await startApply(id);
    release();

    const res = await exporting;
    expect(res.status).toBe(200);
    const lines = (await res.text()).trim().split('\n').map((line) => JSON.parse(line));
    expect(lines.map((line) => line.position)).toEqual([1, 2]);
    expect(lines.map((line) => line.decision.kind)).toEqual(['discard', 'discard']);
    const settled = await appliedCheckout(app, id);
    expect(outcomes(settled)).toEqual([[ids(0)[0], 'done'], [ids(1)[0], 'done']]);
  });

  it('touches the broker only once the pending entry and the Discarded copy are committed (ADR 0001)', async () => {
    const id = await checkoutWith(DISCARD, 1);
    const atStep: any[] = [];
    let steps = 0;
    beforeApplyStep = async () => {
      steps++;
      atStep.push(...(await entries(id)));
    };
    const { arrived, release } = hold('record');

    await startApply(id);
    await arrived;
    expect(steps).toBe(0);
    expect(await entries(id)).toEqual([]);
    release();
    const ended = await appliedCheckout(app, id);

    expect(atStep).toEqual([expect.objectContaining({ outcome: 'pending', message: expect.objectContaining({ bodyBytes: expect.any(Number) }) })]);
    expect(outcomes(ended)).toEqual([[`${QUEUE}-0`, 'done']]);
    expect((await entries(id))[0].outcome).toBe('done');
    expect(await readyMessageIds('/', QUEUE)).toEqual([]);
  });

  it("refuses a stop while the last step's outcome is written: the last step came first", async () => {
    const id = await checkoutWith(DISCARD, 1);
    const { arrived, release } = hold('setOutcome');

    await startApply(id);
    await arrived;
    const late = await app.post(`/api/checkouts/${id}/apply/stop`);
    release();
    const ended = await appliedCheckout(app, id);

    expect([late.status, late.body.error.code]).toEqual([409, 'apply_not_running']);
    expect(ended.applyProgress.stoppedBy).toBeNull();
    expect((await entries(id))[0].outcome).toBe('done');
  });

  it('lets a stop during a pending write finish that step and attempt no other', async () => {
    const id = await checkoutWith(DISCARD, 2);
    const { arrived, release } = hold('record');

    await startApply(id);
    await arrived;
    const stopped = await app.post(`/api/checkouts/${id}/apply/stop`);
    held = null;
    release();
    const ended = await appliedCheckout(app, id);

    expect(stopped.status).toBe(200);
    expect(outcomes(ended)).toEqual([
      [`${QUEUE}-0`, 'done'],
      [`${QUEUE}-1`, 'not-attempted'],
    ]);
    expect(ended.applyProgress.stoppedBy).toBe(testOperator);
    expect(await readyMessageIds('/', QUEUE)).toEqual(ids(1));
  });

  it('acks nothing when the Checkout is lost during a pending write', async () => {
    const id = await checkoutWith(DISCARD, 2);
    const { arrived, release } = hold('record');

    await startApply(id);
    await arrived;
    await loseCheckout(id);
    held = null;
    release();
    const ended = await appliedCheckout(app, id);

    expect(outcomes(ended)).toEqual([
      [`${QUEUE}-0`, 'failed'],
      [`${QUEUE}-1`, 'not-attempted'],
    ]);
    expect((await entries(id)).map((e) => e.outcome)).toEqual(['failed']);
    expect(await readyMessageIds('/', QUEUE)).toEqual(ids(0, 1));
  });

  it('publishes nothing when the Checkout is lost during the pending write of a Move', async () => {
    const destination = uniqueName('delayed-move');
    await withChannel('/', (ch) => ch.assertQueue(destination));
    try {
      const id = await checkoutWith({ kind: 'move', destination: { queue: destination } }, 1);
      const { arrived, release } = hold('record');

      await startApply(id);
      await arrived;
      await loseCheckout(id);
      release();
      const ended = await appliedCheckout(app, id);

      expect(outcomes(ended)).toEqual([[`${QUEUE}-0`, 'failed']]);
      expect(await readyMessageIds('/', destination)).toEqual([]);
      expect(await readyMessageIds('/', QUEUE)).toEqual(ids(0));
    } finally {
      await withChannel('/', (ch) => ch.deleteQueue(destination));
    }
  });
});
