// Restore across Replicas (#92): whichever Replica is asked, a Message is republished once,
// and not while another Replica is still carrying out its Discard.
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { AuditStore } from '../../src/server/audit/audit-store.js';
import { appliedCheckout, eventually, purgeQueues, readyMessageIds, testProfile, withChannel } from './harness.js';
import { startTwoReplicas, type ReplicaBrowser, type TwoReplicas } from './two-replicas.js';

const QUEUE = 'restore-replicas.dlq';
const ana = { sub: 'ana-sub', email: 'ana@example.com', groups: ['ops'] };
const startPath = `/api/profiles/dev/vhosts/%2F/queues/${QUEUE}/checkouts`;

describe('Restore across Replicas', () => {
  let replicas: TwoReplicas;
  let browser: ReplicaBrowser;
  /** When set, a Replica's look for earlier Restores waits here. */
  let afterLookingForRestores: (() => Promise<void>) | null = null;
  /** When set, an outcome waits here, so the Apply writing it keeps running. */
  let beforeOutcome: Promise<void> | null = null;

  const wrapAuditStore = (store: AuditStore): AuditStore =>
    new Proxy(store, {
      get(target, key) {
        if (key === 'list') {
          return async (...args: Parameters<AuditStore['list']>) => {
            const entries = await target.list(...args);
            if (args[0]?.restoreOf !== undefined) await afterLookingForRestores?.();
            return entries;
          };
        }
        if (key === 'setOutcome') {
          return async (...args: Parameters<AuditStore['setOutcome']>) => {
            await beforeOutcome;
            return target.setOutcome(...args);
          };
        }
        const value = Reflect.get(target, key);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });

  /** Discards a Message through Replica a; answers the Checkout once its Apply has started. */
  const applyDiscard = async (messageId: string): Promise<string> => {
    await withChannel('/', async (ch) => {
      ch.sendToQueue(QUEUE, Buffer.from(`body of ${messageId}`), { messageId });
      await ch.waitForConfirms();
    });
    const on = browser.to(replicas.a);
    const start = await on.post(startPath, {});
    expect(start.status).toBe(201);
    const { id, messages } = start.body.checkout as { id: string; messages: Array<{ handle: string }> };
    await on.post(`/api/checkouts/${id}/decisions`, { handles: messages.map((m) => m.handle), decision: { kind: 'discard', reason: 'bad payload' } });
    const applied = await on.post(`/api/checkouts/${id}/apply`, { confirm: true });
    expect(applied.status).toBe(202);
    return id;
  };

  const discardEntry = (messageId: string, outcome: string): Promise<{ id: number }> =>
    eventually(async () => {
      const { entries } = (await browser.to(replicas.a).get(`/api/audit-entries?action=discard&messageId=${messageId}`)).body;
      expect(entries).toMatchObject([{ outcome }]);
      return entries[0] as { id: number };
    });

  beforeAll(async () => {
    await withChannel('/', async (ch) => {
      await ch.assertQueue(QUEUE, { durable: true });
    });
    await purgeQueues('/', [QUEUE]);
    replicas = await startTwoReplicas({
      profiles: [testProfile({ name: 'dev', roles: { admin: ['ops'] } })],
      perReplica: () => ({ wrapAuditStore }),
    });
    browser = replicas.browser();
    await browser.signIn(ana);
  });
  afterAll(async () => {
    await replicas?.close();
  });
  afterEach(async () => {
    afterLookingForRestores = null;
    beforeOutcome = null;
    await purgeQueues('/', [QUEUE]);
  });

  it('republishes once when two Restores race through two Replicas', async () => {
    const checkout = await applyDiscard('race-1');
    await appliedCheckout(browser.to(replicas.a), checkout);
    const { id } = await discardEntry('race-1', 'done');

    // Both have looked for an earlier Restore and found none before either goes on.
    let looked = 0;
    let bothLooked!: () => void;
    const both = new Promise<void>((resolve) => (bothLooked = resolve));
    afterLookingForRestores = () => {
      if (++looked === 2) bothLooked();
      return both;
    };
    const path = `/api/audit-entries/${id}/restore`;
    const answers = await Promise.all([browser.to(replicas.a).post(path, { confirm: true }), browser.to(replicas.b).post(path, { confirm: true })]);

    expect(answers.map((a) => a.status).sort()).toEqual([200, 409]);
    expect(answers.find((a) => a.status === 409)!.body.error.code).toBe('already_restored');
    expect(await readyMessageIds('/', QUEUE)).toEqual(['race-1']);
    const { entries } = (await browser.get('/api/audit-entries?action=restore&messageId=race-1')).body;
    expect(entries).toMatchObject([{ restoreOf: id, outcome: 'done' }]);
  });

  it("refuses a Restore during another Replica's running Discard, and allows it once that is done", async () => {
    let release!: () => void;
    beforeOutcome = new Promise<void>((resolve) => (release = resolve));
    const checkout = await applyDiscard('running-1');
    const { id } = await discardEntry('running-1', 'pending');
    const path = `/api/audit-entries/${id}/restore`;

    const refused = await browser.to(replicas.b).post(path, { confirm: true, confirmUncertain: true });
    expect([refused.status, refused.body.error.code]).toEqual([409, 'discard_in_progress']);
    expect(await readyMessageIds('/', QUEUE)).toEqual([]);

    release();
    await appliedCheckout(browser.to(replicas.a), checkout);
    await discardEntry('running-1', 'done');
    const restored = await browser.to(replicas.b).post(path, { confirm: true });
    expect([restored.status, restored.body.entry?.outcome]).toEqual([200, 'done']);
    expect(await readyMessageIds('/', QUEUE)).toEqual(['running-1']);
  });
});
