// Four-eyes when requester and approver reach different Replicas. The requester's Checkout
// is always on Replica a; what a test asks goes through the Replica it names, and it asserts
// what the Operators see.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { appliedCheckout, deadLetter, deadLetterRoutes, eventually, purgeQueues, readyCount, readyMessageIds, seedMessages, testProfile, withChannel } from './harness.js';
import { delayedAuditStore } from '../support/delayed-audit-store.js';
import { startTwoReplicas, type Replica, type ReplicaBrowser, type TwoReplicas } from './two-replicas.js';

const QUEUE = 'approval-replicas.dlq';
const startPath = `/api/profiles/prod/vhosts/%2F/queues/${QUEUE}/checkouts`;
const rita = { sub: 'rita-sub', email: 'rita@example.com', groups: ['oncall'] };
const alan = { sub: 'alan-sub', email: 'alan@example.com', groups: ['oncall'] };
const vera = { sub: 'vera-sub', email: 'vera@example.com', groups: ['support'] };
const DISCARD = { kind: 'discard', reason: 'bad payload' };
const profiles = () => [testProfile({ name: 'prod', protected: true, roles: { viewer: ['support'], operator: ['oncall'] } })];
const leaseTiming = { renewEveryMs: 100, holdsForMs: 400 };

/** A gate a test opens later: `wait` resolves once `open` is called. */
function gate() {
  let open!: () => void;
  const wait = new Promise<void>((resolve) => (open = resolve));
  return { wait, open };
}

const signedIn = async (replicas: TwoReplicas, identity: { sub: string; email: string; groups: string[] }) => {
  const browser = replicas.browser();
  await browser.signIn(identity);
  return browser;
};

/** Rita's Checkout on `owner`, with her first two Messages to Discard. */
async function checkoutWithDiscards(requester: ReplicaBrowser, owner: Replica) {
  await seedMessages('/', QUEUE, 3);
  const started = await requester.to(owner).post(startPath, {});
  expect(started.status).toBe(201);
  const { id, messages } = started.body.checkout as { id: string; messages: Array<{ handle: number }> };
  const handles = messages.map((m) => m.handle);
  const decided = await requester.to(owner).post(`/api/checkouts/${id}/decisions`, { handles: handles.slice(0, 2), decision: DISCARD });
  expect(decided.status).toBe(200);
  return { id, handles };
}

const requestApproval = (browser: ReplicaBrowser, id: string) =>
  browser.post(`/api/checkouts/${id}/approval-request`, { confirm: true, confirmQueueName: QUEUE });

const statuses = (checkout: { lastApply: { outcomes: Array<{ status: string }> } }) => checkout.lastApply.outcomes.map((o) => o.status);

describe('Approval across Replicas', () => {
  let replicas: TwoReplicas;
  let requester: ReplicaBrowser;
  let approver: ReplicaBrowser;
  let beforeApplyStep: (() => Promise<void>) | null = null;
  const open: string[] = [];

  /** Rita's Checkout on Replica a, waiting for Approval. */
  const waiting = async () => {
    const { id, handles } = await checkoutWithDiscards(requester, replicas.a);
    open.push(id);
    const requested = await requestApproval(requester.to(replicas.a), id);
    expect(requested.status).toBe(200);
    return { id, handles };
  };

  beforeAll(async () => {
    await withChannel('/', (ch) => ch.assertQueue(QUEUE, { durable: true }));
    await purgeQueues('/', [QUEUE]);
    replicas = await startTwoReplicas({
      profiles: profiles(),
      perReplica: () => ({ checkoutTestHooks: { beforeApplyStep: async () => beforeApplyStep?.() } }),
    });
    requester = await signedIn(replicas, rita);
    approver = await signedIn(replicas, alan);
  });
  afterEach(async () => {
    beforeApplyStep = null;
    for (const id of open.splice(0)) await requester.to(replicas.a).post(`/api/checkouts/${id}/end`);
    await purgeQueues('/', [QUEUE]);
  });
  afterAll(async () => {
    await replicas?.close();
    await withChannel('/', (ch) => ch.deleteQueue(QUEUE));
  });

  it('lists a waiting Approval through either Replica, with its times measured when asked', async () => {
    const { id } = await waiting();

    for (const replica of [replicas.a, replicas.b]) {
      const { status, body } = await approver.to(replica).get('/api/approvals');
      expect(status).toBe(200);
      expect(body.approvals).toEqual([
        expect.objectContaining({ checkoutId: id, requester: rita.email, profile: 'prod', vhost: '/', queue: QUEUE, decisionSummary: expect.arrayContaining([expect.objectContaining({ kind: 'discard', count: 2 })]) }),
      ]);
    }

    await new Promise((resolve) => setTimeout(resolve, 300));
    const [later] = (await approver.to(replicas.b).get('/api/approvals')).body.approvals;
    expect(later.waitingMs).toBeGreaterThanOrEqual(300);
    expect(new Date(later.endsAt).getTime() - Date.now() - later.remainingMs).toBeLessThan(1000);
    expect(new Date(later.endsAt).getTime() - new Date(later.requestedAt).getTime() - later.remainingMs).toBeGreaterThanOrEqual(300);
  });

  it('lists Approvals from both Replicas together, oldest first', async () => {
    const { id: first } = await waiting();
    const second = await signedIn(replicas, { sub: 'omar-sub', email: 'omar@example.com', groups: ['oncall'] });
    const otherQueue = `${QUEUE}.2`;
    await withChannel('/', (ch) => ch.assertQueue(otherQueue, { durable: true }));
    await seedMessages('/', otherQueue, 1);
    const started = await second.to(replicas.b).post(`/api/profiles/prod/vhosts/%2F/queues/${otherQueue}/checkouts`, {});
    const { id: secondId, messages } = started.body.checkout;
    try {
      await second.to(replicas.b).post(`/api/checkouts/${secondId}/decisions`, { handles: [messages[0].handle], decision: DISCARD });
      expect((await second.to(replicas.b).post(`/api/checkouts/${secondId}/approval-request`, { confirm: true, confirmQueueName: otherQueue })).status).toBe(200);

      for (const replica of [replicas.a, replicas.b]) {
        const { body } = await approver.to(replica).get('/api/approvals');
        expect(body.approvals.map((a: { checkoutId: string }) => a.checkoutId)).toEqual([first, secondId]);
      }
    } finally {
      await second.to(replicas.b).post(`/api/checkouts/${secondId}/end`);
      await withChannel('/', (ch) => ch.deleteQueue(otherQueue));
    }
  });

  it("hides a request from its requester and from who may not approve, on either Replica", async () => {
    await waiting();
    const viewer = await signedIn(replicas, vera);
    for (const replica of [replicas.a, replicas.b]) {
      expect((await requester.to(replica).get('/api/approvals')).body.approvals).toEqual([]);
      expect((await viewer.to(replica).get('/api/approvals')).body.approvals).toEqual([]);
    }
  });

  it('requests and withdraws through the Replica that does not own the Checkout', async () => {
    const { id } = await checkoutWithDiscards(requester, replicas.a);
    open.push(id);
    const viaB = requester.to(replicas.b);

    const requested = await requestApproval(viaB, id);
    expect(requested.status).toBe(200);
    expect(requested.body.checkout.status).toBe('awaiting_approval');
    expect((await approver.to(replicas.b).get('/api/approvals')).body.approvals).toHaveLength(1);

    const withdrawn = await viaB.request('DELETE', `/api/checkouts/${id}/approval-request`);
    expect(withdrawn.status).toBe(200);
    expect(withdrawn.body.checkout.status).toBe('active');
    expect((await approver.to(replicas.b).get('/api/approvals')).body.approvals).toEqual([]);
  });

  it("refuses another Operator's request and withdrawal as the owner does", async () => {
    const { id } = await checkoutWithDiscards(requester, replicas.a);
    open.push(id);
    const viaB = approver.to(replicas.b);
    for (const refused of [await requestApproval(viaB, id), await viaB.request('DELETE', `/api/checkouts/${id}/approval-request`)]) {
      expect([refused.status, refused.body.error.code]).toEqual([403, 'not_checkout_owner']);
    }
  });

  it('reads and compares the Messages of a waiting Approval through either Replica', async () => {
    const { id, handles } = await waiting();
    for (const replica of [replicas.a, replicas.b]) {
      const viaReplica = approver.to(replica);
      const read = await viaReplica.get(`/api/approvals/${id}`);
      expect(read.status).toBe(200);
      expect(read.body.checkout).toMatchObject({ id, status: 'awaiting_approval', operator: rita.email, heldCount: 3 });

      const message = await viaReplica.get(`/api/approvals/${id}/messages/${handles[0]}`);
      expect(message.status).toBe(200);
      expect(message.body.message.handle).toBe(handles[0]);

      const compared = await viaReplica.get(`/api/approvals/${id}/compare?a=${handles[0]}&b=${handles[1]}`);
      expect(compared.status).toBe(200);
      expect([compared.body.left.handle, compared.body.right.handle]).toEqual([handles[0], handles[1]]);

      const twice = await viaReplica.get(`/api/approvals/${id}/compare?a=${handles[0]}&b=${handles[0]}`);
      expect(twice.status).toBe(400);
    }
  });

  it('refuses the requester as approver and a viewer through the other Replica', async () => {
    const { id } = await waiting();
    const own = await requester.to(replicas.b).post(`/api/approvals/${id}/approve`, { confirmQueueName: QUEUE });
    expect([own.status, own.body.error.code]).toEqual([403, 'cannot_approve_own_apply']);
    const viewer = await signedIn(replicas, vera);
    const refused = await viewer.to(replicas.b).post(`/api/approvals/${id}/approve`, { confirmQueueName: QUEUE });
    expect([refused.status, refused.body.error.code]).toEqual([403, 'role_required']);
  });

  it('approves through the other Replica, lets the approver follow it, and records both people', async () => {
    const { id } = await waiting();
    const viaB = approver.to(replicas.b);

    const untyped = await viaB.post(`/api/approvals/${id}/approve`, {});
    expect([untyped.status, untyped.body.error.code]).toEqual([400, 'queue_name_confirmation_required']);

    const approved = await viaB.post(`/api/approvals/${id}/approve`, { confirmQueueName: QUEUE });
    expect(approved.status).toBe(202);
    expect((await viaB.get('/api/approvals')).body.approvals).toEqual([]);

    const applied = await appliedCheckout(requester.to(replicas.b), id);
    expect(statuses(applied)).toEqual(['done', 'done', 'kept']);
    const followed = await viaB.get(`/api/approvals/${id}`);
    expect(followed.status).toBe(200);
    expect(followed.body.checkout.lastApply).toBeTruthy();

    const { body } = await approver.to(replicas.a).get(`/api/audit-entries?queue=${encodeURIComponent(QUEUE)}&checkoutId=${id}`);
    const entries = body.entries.filter((e: { checkoutId: string }) => e.checkoutId === id);
    expect(entries).toHaveLength(2);
    for (const entry of entries) expect(entry).toMatchObject({ operatorId: rita.sub, approverId: alan.sub, approverName: alan.email, outcome: 'done' });
  });

  it('rejects through the other Replica, and the requester sees the reason', async () => {
    const { id } = await waiting();
    const viaB = approver.to(replicas.b);

    const noReason = await viaB.post(`/api/approvals/${id}/reject`, { reason: ' ' });
    expect([noReason.status, noReason.body.error.code]).toEqual([400, 'invalid_request']);

    const rejected = await viaB.post(`/api/approvals/${id}/reject`, { reason: 'too many' });
    expect(rejected.status).toBe(200);
    expect((await viaB.get('/api/approvals')).body.approvals).toEqual([]);

    const seen = (await requester.to(replicas.a).get(`/api/checkouts/${id}`)).body.checkout;
    expect(seen.status).toBe('active');
    expect(seen.rejection).toMatchObject({ reason: 'too many', rejectedBy: alan.email });
  });

  it('stops an approved Apply through the other Replica', async () => {
    const { id } = await waiting();
    const held = gate();
    const release = gate();
    beforeApplyStep = async () => {
      beforeApplyStep = null;
      held.open();
      await release.wait;
    };
    const viaB = approver.to(replicas.b);
    expect((await viaB.post(`/api/approvals/${id}/approve`, { confirmQueueName: QUEUE })).status).toBe(202);
    await held.wait;

    const stopped = await viaB.post(`/api/approvals/${id}/apply/stop`);
    expect(stopped.status).toBe(200);
    expect(stopped.body.checkout.applyProgress.stoppedBy).toBeTruthy();

    release.open();
    expect(statuses(await appliedCheckout(requester.to(replicas.b), id))).toEqual(['done', 'not-attempted', 'kept']);
  });

  it('drops the request from the list when the Checkout ends', async () => {
    const { id } = await waiting();
    expect((await requester.to(replicas.b).post(`/api/checkouts/${id}/end`)).status).toBe(200);
    expect((await approver.to(replicas.b).get('/api/approvals')).body.approvals).toEqual([]);
    const late = await approver.to(replicas.b).get(`/api/approvals/${id}`);
    expect([late.status, late.body.error.code]).toEqual([409, 'not_awaiting_approval']);
  });
});

describe('a Canary with Approval across Replicas', () => {
  const route = deadLetterRoutes.classic;
  const startCanary = `/api/profiles/prod/vhosts/%2F/queues/${encodeURIComponent(route.dlq)}/checkouts`;

  it('continues through the other Replica, with no second Approval', async () => {
    const replicas = await startTwoReplicas({ profiles: profiles() });
    try {
      const requester = await signedIn(replicas, rita);
      const approver = await signedIn(replicas, alan);
      await deadLetter(route, [0, 1].map((i) => ({ body: `order ${i}`, options: { messageId: `canary-${i}` } })));
      await purgeQueues('/', route.dlqs.filter((q) => q !== route.dlq));
      const { id, messages } = (await requester.to(replicas.a).post(startCanary, {})).body.checkout;
      const handles = messages.map((m: { handle: number }) => m.handle);
      await requester.to(replicas.a).post(`/api/checkouts/${id}/decisions`, { handles, decision: { kind: 'replay' } });
      const requested = await requester.to(replicas.b).post(`/api/checkouts/${id}/approval-request`, { confirm: true, confirmQueueName: route.dlq, canary: true });
      expect(requested.status).toBe(200);
      const viaB = approver.to(replicas.b);
      expect((await viaB.get('/api/approvals')).body.approvals[0].canary).toMatchObject({ handle: expect.any(Number) });
      expect((await viaB.post(`/api/approvals/${id}/approve`, { confirmQueueName: route.dlq })).status).toBe(202);
      await eventually(async () => {
        expect((await viaB.get(`/api/approvals/${id}`)).body.checkout.applyProgress?.phase).toBe('canary_watch');
      });
      expect((await viaB.post(`/api/approvals/${id}/apply/continue`)).status).toBe(200);
      expect(statuses(await appliedCheckout(requester.to(replicas.b), id))).toEqual(['done', 'done']);
      expect(await readyMessageIds('/', route.workQueue)).toHaveLength(2);
    } finally {
      await replicas.close();
      await purgeQueues('/', [...route.dlqs, route.workQueue]);
    }
  });
});

describe('the list while records are written behind', () => {
  beforeEach(async () => {
    await withChannel('/', (ch) => ch.assertQueue(QUEUE, { durable: true }));
    await purgeQueues('/', [QUEUE]);
  });

  it('shows a request as soon as it is answered, and not after it is closed, on a slow store', async () => {
    const replicas = await startTwoReplicas({
      profiles: profiles(),
      perReplica: (name) => (name === 'a' ? { wrapAuditStore: (store) => delayedAuditStore(store, 150) } : {}),
    });
    try {
      const requester = await signedIn(replicas, rita);
      const approver = await signedIn(replicas, alan);
      const { id } = await checkoutWithDiscards(requester, replicas.a);
      const listed = async () => (await approver.to(replicas.b).get('/api/approvals')).body.approvals.length;

      expect((await requestApproval(requester.to(replicas.a), id)).status).toBe(200);
      expect(await listed()).toBe(1);
      expect((await requester.to(replicas.a).request('DELETE', `/api/checkouts/${id}/approval-request`)).status).toBe(200);
      expect(await listed()).toBe(0);

      expect((await requestApproval(requester.to(replicas.a), id)).status).toBe(200);
      expect((await approver.to(replicas.a).post(`/api/approvals/${id}/reject`, { reason: 'no' })).status).toBe(200);
      expect(await listed()).toBe(0);

      expect((await requestApproval(requester.to(replicas.a), id)).status).toBe(200);
      expect((await approver.to(replicas.a).post(`/api/approvals/${id}/approve`, { confirmQueueName: QUEUE })).status).toBe(202);
      expect(await listed()).toBe(0);
      await appliedCheckout(requester.to(replicas.a), id);
    } finally {
      await replicas.close();
      await purgeQueues('/', [QUEUE]);
    }
  });
});

describe('an Approval whose Owner Replica crashes', () => {
  it('leaves the list, and the other Replica answers that it is gone', async () => {
    await withChannel('/', (ch) => ch.assertQueue(QUEUE, { durable: true }));
    await purgeQueues('/', [QUEUE]);
    const replicas = await startTwoReplicas({ profiles: profiles(), replicaLeaseTiming: leaseTiming });
    try {
      const requester = await signedIn(replicas, rita);
      const approver = await signedIn(replicas, alan);
      const { id } = await checkoutWithDiscards(requester, replicas.a);
      expect((await requestApproval(requester.to(replicas.a), id)).status).toBe(200);
      const viaB = approver.to(replicas.b);
      expect((await viaB.get('/api/approvals')).body.approvals).toHaveLength(1);

      await replicas.a.crash();

      await eventually(async () => {
        expect((await viaB.get('/api/approvals')).body.approvals).toEqual([]);
      });
      await eventually(async () => {
        const refused = await viaB.post(`/api/approvals/${id}/approve`, { confirmQueueName: QUEUE });
        expect([refused.status, refused.body.error.code]).toEqual([409, 'not_awaiting_approval']);
      });
      await eventually(async () => {
        expect(await readyCount('/', QUEUE)).toBe(3);
      });
    } finally {
      await replicas.close();
      await purgeQueues('/', [QUEUE]);
    }
  });
});
