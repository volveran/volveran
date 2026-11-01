// An Owner Replica that dies (#92): its Operators see a Lost Checkout through any other
// Replica, with the reason; one that is leased but cannot be reached gets a retryable error.
import { setTimeout as sleep } from 'node:timers/promises';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { AuditStore } from '../../src/server/audit/audit-store.js';
import { closedPort, eventually, management, purgeQueues, readyCount, seedMessages, testProfile, uniqueName, withChannel } from './harness.js';
import { startTwoReplicas, type ReplicaBrowser, type TwoReplicas } from './two-replicas.js';

const QUEUE = 'replica-crash.dlq';
const ana = { sub: 'ana-sub', email: 'ana@example.com', groups: ['ops'] };
const ben = { sub: 'ben-sub', email: 'ben@example.com', groups: ['ops'] };
const startPath = (queue: string) => `/api/profiles/dev/vhosts/%2F/queues/${queue}/checkouts`;
const profile = () => testProfile({ name: 'dev', roles: { operator: ['ops'] } });
const leaseTiming = { renewEveryMs: 100, holdsForMs: 1_000 };

describe('an Owner Replica that crashes', () => {
  let replicas: TwoReplicas;
  let browser: ReplicaBrowser;

  beforeAll(async () => {
    await withChannel('/', (ch) => ch.assertQueue(QUEUE, { durable: true }));
  });
  afterEach(async () => {
    await replicas?.close();
    await purgeQueues('/', [QUEUE]);
  });

  const start = async (options: Parameters<typeof startTwoReplicas>[0] = {}) => {
    replicas = await startTwoReplicas({ profiles: [profile()], replicaLeaseTiming: leaseTiming, ...options });
    browser = replicas.browser();
    await browser.signIn(ana);
  };

  it('shows a Lost Checkout with the reason through the other Replica, and its Messages are back in the queue', async () => {
    await start();
    await seedMessages('/', QUEUE, 3);
    const { id } = (await browser.to(replicas.a).post(startPath(QUEUE), {})).body.checkout as { id: string };
    expect(await readyCount('/', QUEUE)).toBe(0);

    await replicas.a.crash();

    const lost = await eventually(async () => {
      const view = await browser.to(replicas.b).get(`/api/checkouts/${id}`);
      expect(view.body.checkout?.status).toBe('lost');
      return view.body.checkout;
    });
    expect(lost.id).toBe(id);
    expect(lost.queue).toBe(QUEUE);
    expect(lost.operator).toBe(ana.email);
    expect(lost.messages).toEqual([]);
    expect(lost.lostReason).toMatch(/Replica/);
    await eventually(async () => expect(await readyCount('/', QUEUE)).toBe(3));

    // As on the owner: a heartbeat answers it, and it can be neither revived nor Applied.
    const beat = await browser.to(replicas.b).post(`/api/checkouts/${id}/heartbeat`);
    expect([beat.status, beat.body.checkout.status]).toEqual([200, 'lost']);
    // And it is still the owner's alone.
    const other = replicas.browser();
    await other.signIn(ben);
    const refused = await other.to(replicas.b).get(`/api/checkouts/${id}`);
    expect([refused.status, refused.body.error.code]).toEqual([403, 'not_checkout_owner']);
    expect((await browser.to(replicas.b).get('/api/session')).body.checkoutId).toBeNull();

    // The Operator can simply start again.
    const again = await browser.to(replicas.b).post(startPath(QUEUE), {});
    expect(again.status, JSON.stringify(again.body)).toBe(201);
    expect(again.body.checkout.heldCount).toBe(3);
    await browser.to(replicas.b).post(`/api/checkouts/${again.body.checkout.id}/end`);
  });

  it('answers a Checkout that had already ended as ended, with its reason', async () => {
    await start();
    await seedMessages('/', QUEUE, 1);
    const { id } = (await browser.to(replicas.a).post(startPath(QUEUE), {})).body.checkout as { id: string };
    await browser.to(replicas.a).post(`/api/checkouts/${id}/end`);
    // The record's status is written behind the change.
    await eventually(async () => {
      const { rows } = await replicas.database.query('SELECT status FROM live_checkouts WHERE id = $1', [id]);
      expect(rows[0].status).toBe('ended');
    });

    await replicas.a.crash();

    const view = await eventually(async () => {
      const answer = await browser.to(replicas.b).get(`/api/checkouts/${id}`);
      expect(answer.status).toBe(200);
      return answer.body.checkout;
    });
    expect([view.status, view.endReason, view.lostReason]).toEqual(['ended', 'operator', null]);
  });

  it('keeps the Delivery Budget warning afterwards: the crash cost one delivery, and a new Checkout through the other Replica says so', async () => {
    const quorum = uniqueName('replica-crash-quorum');
    await withChannel('/', (ch) => ch.assertQueue(quorum, { durable: true, arguments: { 'x-queue-type': 'quorum', 'x-delivery-limit': 2 } }));
    try {
      // The management API shows a queue's delivery limit only from its first statistics.
      await eventually(async () => expect(((await management(`/queues/%2F/${quorum}`)).body as { delivery_limit?: number }).delivery_limit).toBe(2), 20_000);
      await start();
      await seedMessages('/', quorum, 2);
      const before = (await browser.to(replicas.a).post(startPath(quorum), {})).body.checkout;
      expect(before.queueType).toBe('quorum');
      expect(before.messages[0].deliveryBudget).toEqual({ remaining: 2, warning: null });

      await replicas.a.crash();

      const lost = await eventually(async () => {
        const view = await browser.to(replicas.b).get(`/api/checkouts/${before.id}`);
        expect(view.body.checkout?.status).toBe('lost');
        return view.body.checkout;
      });
      expect(lost.queueType).toBe('quorum');
      expect(lost.deliveryLimit).toBe(2);
      expect(lost.lostReason).toMatch(/uses up 1 of the Delivery Budget/);
      await eventually(async () => expect(await readyCount('/', quorum)).toBe(2));

      const again = await eventually(async () => {
        const started = await browser.to(replicas.b).post(startPath(quorum), {});
        expect(started.status, JSON.stringify(started.body)).toBe(201);
        return started.body.checkout;
      });
      expect(again.messages).toHaveLength(2);
      for (const message of again.messages) {
        expect(message.deliveryBudget.remaining).toBe(1);
        expect(message.deliveryBudget.warning).toMatch(/if this Checkout is lost, the broker drops this Message/);
      }
      await browser.to(replicas.b).post(`/api/checkouts/${again.id}/end`);
    } finally {
      await withChannel('/', (ch) => ch.deleteQueue(quorum));
    }
  });

  it('leaves Audit Entries saying what is known of an interrupted Apply, and the rest back in the queue', async () => {
    let steps = 0;
    let release = () => {};
    const stuck = new Promise<void>((resolve) => (release = resolve));
    await start({
      perReplica: (name) => ({
        // The second step stops with its `pending` entry written and the broker not yet touched.
        checkoutTestHooks: name === 'a' ? { beforeApplyStep: async () => void (++steps === 2 && (await stuck)) } : {},
        // A short lease, so that when the first Replica started, the leader, dies the other soon clears up.
        leaderTestHooks: { timing: { leaseMs: 600, renewMs: 200 } },
      }),
    });
    try {
      await seedMessages('/', QUEUE, 3);
      const { id, messages } = (await browser.to(replicas.a).post(startPath(QUEUE), {})).body.checkout as { id: string; messages: Array<{ handle: number; messageId: string }> };
      const decided = await browser.to(replicas.a).post(`/api/checkouts/${id}/decisions`, {
        handles: messages.map((m) => m.handle),
        decision: { kind: 'discard', reason: 'poison' },
      });
      expect(decided.status).toBe(200);
      expect((await browser.to(replicas.a).post(`/api/checkouts/${id}/apply`, { confirm: true })).status).toBe(202);
      await eventually(async () => expect(steps).toBe(2));

      await replicas.a.crash();

      await eventually(async () => {
        const view = await browser.to(replicas.b).get(`/api/checkouts/${id}`);
        expect(view.body.checkout?.status).toBe('lost');
      });
      expect((await browser.to(replicas.b).get(`/api/checkouts/${id}`)).body.checkout.ownerGone).toBe(true);
      const entries = await eventually(async () => {
        const answer = await browser.to(replicas.b).get(`/api/audit-entries?checkoutId=${id}`);
        const found = answer.body.entries as Array<{ messageId: string; outcome: string; outcomeReason: string | null }>;
        expect(found.map((e) => e.outcome).sort()).toEqual(['done', 'uncertain']);
        return found;
      }, 20_000);
      const uncertain = entries.find((e) => e.outcome === 'uncertain')!;
      expect(uncertain.messageId).toBe(messages[1]!.messageId);
      expect(uncertain.outcomeReason).toMatch(/stopped before writing its outcome/);
      expect(entries.find((e) => e.outcome === 'done')!.messageId).toBe(messages[0]!.messageId);
      // The first was settled; the second never reached the broker, the third was never begun.
      await eventually(async () => expect(await readyCount('/', QUEUE)).toBe(2));
    } finally {
      release();
    }
  });

  it("clears up its lease and records, and the Lost Checkout, once it has been readable for as long as a Checkout that is over", async () => {
    await start({ endedCheckoutRetentionMs: 2_000, perReplica: () => ({ leaderTestHooks: { timing: { leaseMs: 600, renewMs: 200 } } }) });
    await seedMessages('/', QUEUE, 1);
    const { id } = (await browser.to(replicas.a).post(startPath(QUEUE), {})).body.checkout as { id: string };

    await replicas.a.crash();

    await eventually(async () => {
      expect((await browser.to(replicas.b).get(`/api/checkouts/${id}`)).body.checkout?.status).toBe('lost');
    });
    await eventually(async () => {
      expect((await replicas.database.query('SELECT 1 FROM live_checkouts')).rows).toHaveLength(0);
      expect((await replicas.database.query('SELECT 1 FROM replicas')).rows).toHaveLength(1);
    }, 20_000);
    await eventually(async () => {
      const view = await browser.to(replicas.b).get(`/api/checkouts/${id}`);
      expect([view.status, view.body.error?.code]).toEqual([404, 'checkout_not_found']);
    });
  });
});

describe('an Owner Replica that is leased but cannot be reached', () => {
  it('answers a retryable error, and nothing is reported lost', async () => {
    await withChannel('/', (ch) => ch.assertQueue(QUEUE, { durable: true }));
    const nowhere = await closedPort();
    const replicas = await startTwoReplicas({
      profiles: [profile()],
      replicaLeaseTiming: leaseTiming,
      // Alive and renewing its lease, but the other Replica cannot reach it at the address it gave.
      perReplica: (name) => (name === 'a' ? { env: { VOLVERAN_FORWARDING_ADDRESS: `127.0.0.1:${nowhere}` } } : {}),
    });
    try {
      const browser = replicas.browser();
      await browser.signIn(ana);
      await seedMessages('/', QUEUE, 2);
      const { id } = (await browser.to(replicas.a).post(startPath(QUEUE), {})).body.checkout as { id: string };

      // Past several times how long a renewal holds, the answer stays the same.
      const until = Date.now() + leaseTiming.holdsForMs * 3;
      do {
        for (const answer of [await browser.to(replicas.b).get(`/api/checkouts/${id}`), await browser.to(replicas.b).post(`/api/checkouts/${id}/heartbeat`)]) {
          expect([answer.status, answer.body.error?.code, answer.body.error?.tryAgain]).toEqual([503, 'replica_unreachable', true]);
        }
        await sleep(200);
      } while (Date.now() < until);

      expect((await browser.to(replicas.a).get(`/api/checkouts/${id}`)).body.checkout.status).toBe('active');
      expect(await readyCount('/', QUEUE)).toBe(0);
      expect((await browser.to(replicas.b).get('/api/session')).body.checkoutId).toBe(id);
      await browser.to(replicas.a).post(`/api/checkouts/${id}/end`);
    } finally {
      await replicas.close();
      await purgeQueues('/', [QUEUE]);
    }
  });
});

describe('an Owner Replica that cannot renew its lease', () => {
  it('gives up its Checkouts, so that what the others report is true: Messages back and the queue free', async () => {
    await withChannel('/', (ch) => ch.assertQueue(QUEUE, { durable: true }));
    let renewals = true;
    const failingRenewals = (store: AuditStore): AuditStore =>
      new Proxy(store, {
        get(target, key: keyof AuditStore) {
          if (key !== 'replicas') return target[key];
          return new Proxy(target.replicas, {
            get(replicas, method: keyof AuditStore['replicas']) {
              if (method === 'renewLease' && !renewals) return () => Promise.reject(new Error('the store cannot be reached'));
              const value = replicas[method];
              return typeof value === 'function' ? value.bind(replicas) : value;
            },
          });
        },
      });
    const replicas = await startTwoReplicas({
      profiles: [profile()],
      replicaLeaseTiming: leaseTiming,
      perReplica: (name) => (name === 'a' ? { wrapAuditStore: failingRenewals } : {}),
    });
    try {
      const browser = replicas.browser();
      await browser.signIn(ana);
      await seedMessages('/', QUEUE, 2);
      const { id } = (await browser.to(replicas.a).post(startPath(QUEUE), {})).body.checkout as { id: string };

      renewals = false;

      const onOwner = await eventually(async () => {
        const view = await browser.to(replicas.a).get(`/api/checkouts/${id}`);
        expect(view.body.checkout.status).toBe('ended');
        return view.body.checkout;
      });
      expect(onOwner.endReason).toBe('lease-ran-out');
      await eventually(async () => expect(await readyCount('/', QUEUE)).toBe(2));
      const onOther = await eventually(async () => {
        const view = await browser.to(replicas.b).get(`/api/checkouts/${id}`);
        expect(view.body.checkout?.status).toBe('ended');
        return view.body.checkout;
      });
      expect(onOther.endReason).toBe('lease-ran-out');
      expect(onOther.messages).toEqual([]);

      // Its lease back, it does not take back what it gave up.
      renewals = true;
      await sleep(leaseTiming.renewEveryMs * 3);
      expect((await browser.to(replicas.a).get(`/api/checkouts/${id}`)).body.checkout.status).toBe('ended');
      expect((await browser.to(replicas.b).get(`/api/checkouts/${id}`)).body.checkout.status).toBe('ended');
    } finally {
      await replicas.close();
      await purgeQueues('/', [QUEUE]);
    }
  });

  it('uses up no Delivery Budget and drops no Message on a quorum queue when the store goes away', async () => {
    const quorum = uniqueName('replica-outage-quorum');
    // At a limit of 0 any return that counts a delivery drops the Message, so all of them still being there is the proof.
    await withChannel('/', (ch) => ch.assertQueue(quorum, { durable: true, arguments: { 'x-queue-type': 'quorum', 'x-delivery-limit': 0 } }));
    let reachable = true;
    // Every write about Replicas fails, as in an outage of the whole store; the rest of the store is not used by this Checkout.
    const cutOff = (store: AuditStore): AuditStore =>
      new Proxy(store, {
        get(target, property) {
          if (property !== 'replicas') {
            const value = target[property as keyof AuditStore] as unknown;
            return typeof value === 'function' ? (value as (...args: unknown[]) => unknown).bind(target) : value;
          }
          return new Proxy(target.replicas, {
            get(replicas, method) {
              const value = replicas[method as keyof typeof replicas] as unknown;
              if (typeof value !== 'function') return value;
              return (...args: unknown[]) => (reachable ? (value as (...a: unknown[]) => unknown).apply(replicas, args) : Promise.reject(new Error('the store cannot be reached')));
            },
          });
        },
      });
    const replicas = await startTwoReplicas({
      profiles: [profile()],
      replicaLeaseTiming: leaseTiming,
      perReplica: (name) => (name === 'a' ? { wrapAuditStore: cutOff } : {}),
    });
    try {
      const browser = replicas.browser();
      await browser.signIn(ana);
      await seedMessages('/', quorum, 3);
      const started = await browser.to(replicas.a).post(startPath(quorum), {});
      expect(started.status, JSON.stringify(started.body)).toBe(201);
      const { id } = started.body.checkout as { id: string };

      reachable = false;
      await eventually(async () => expect(await readyCount('/', quorum)).toBe(3), 20_000);
      reachable = true;

      const onOwner = await eventually(async () => {
        const view = await browser.to(replicas.a).get(`/api/checkouts/${id}`);
        expect(view.body.checkout.status).toBe('ended');
        return view.body.checkout;
      });
      expect(onOwner.endReason).toBe('lease-ran-out');

      const counts = await withChannel('/', async (ch) => {
        const found: Array<number | undefined> = [];
        for (let i = 0; i < 3; i++) {
          const message = await ch.get(quorum);
          if (!message) throw new Error(`Only ${i} Messages came back`);
          found.push(message.properties.headers?.['x-delivery-count'] as number | undefined);
        }
        return found;
      });
      expect(counts).toEqual([undefined, undefined, undefined]);
    } finally {
      await replicas.close();
      await withChannel('/', (ch) => ch.deleteQueue(quorum));
    }
  });
});

afterAll(async () => {
  await withChannel('/', (ch) => ch.deleteQueue(QUEUE));
});
