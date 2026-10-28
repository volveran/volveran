// Four-eyes Approval (Team Mode): on a Protected Profile, an Apply with any
// Decision other than Keep waits for a second Operator with the `operator`
// or `admin` role on the profile. The requester asks for Approval, the
// approver reads the waiting Checkout under /api/approvals/ and approves it,
// which runs the Apply on the requester's Checkout.
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  checkoutConnectionNames,
  closeConnection,
  closedPort,
  eventually,
  purgeQueues,
  readyMessageIds,
  seedMessages,
  startApp,
  testProfile,
  withChannel,
  type TestApp,
} from './harness.js';
import { teamModeEnv, TestBrowser, type TestIdentity } from './oidc-provider.js';

const QUEUE = 'approval.dlq';
const checkoutPath = (profile: string) => `/api/profiles/${profile}/vhosts/%2F/queues/${QUEUE}/checkouts`;
const DISCARD = { kind: 'discard', reason: 'bad payload' };

const rita = { sub: 'rita-sub', email: 'rita@example.com', groups: ['oncall'] };
const alan = { sub: 'alan-sub', email: 'alan@example.com', groups: ['oncall'] };
const ada = { sub: 'ada-sub', email: 'ada@example.com', groups: ['platform'] };
const vera = { sub: 'vera-sub', email: 'vera@example.com', groups: ['support'] };
const sam = { sub: 'sam-sub', email: 'sam@example.com', groups: ['staging-team'] };

describe('Approval', () => {
  let app: TestApp;
  let baseUrl: string;
  /** Checkouts to end after each test: [owner's browser, id]. */
  const open: Array<[TestBrowser, string]> = [];

  async function signedIn(identity: TestIdentity) {
    const browser = new TestBrowser(baseUrl);
    await browser.signIn(identity);
    return browser;
  }

  /** Starts a Checkout of QUEUE on `profile` and Discards the Messages with these message ids. */
  async function checkoutWithDiscards(browser: TestBrowser, profile: string, discard: string[]) {
    const started = await browser.post(checkoutPath(profile));
    expect(started.status).toBe(201);
    const { id, messages } = started.body.checkout;
    open.push([browser, id]);
    const handles = messages.filter((m: any) => discard.includes(m.messageId)).map((m: any) => m.handle);
    const decided = await browser.post(`/api/checkouts/${id}/decisions`, { handles, decision: DISCARD });
    expect(decided.status).toBe(200);
    return { id: id as string, checkout: decided.body.checkout, messages: messages as any[] };
  }

  const requestApproval = (browser: TestBrowser, id: string, confirmQueueName: unknown = QUEUE) =>
    browser.post(`/api/checkouts/${id}/approval-request`, { confirm: true, confirmQueueName });

  beforeAll(async () => {
    await withChannel('/', (ch) => ch.assertQueue(QUEUE, { durable: true }));
    const port = await closedPort();
    baseUrl = `http://127.0.0.1:${port}`;
    app = await startApp({
      profiles: [
        testProfile({
          name: 'prod',
          protected: true,
          roles: { viewer: ['support'], operator: ['oncall'], admin: ['platform'] },
        }),
        testProfile({ name: 'staging', roles: { operator: ['staging-team'] } }),
        testProfile({ name: 'lax', protected: true, requireApproval: false }),
      ],
      port,
      env: teamModeEnv(baseUrl),
    });
  });
  afterEach(async () => {
    for (const [browser, id] of open.splice(0)) await browser.request('DELETE', `/api/checkouts/${id}`);
    await purgeQueues('/', [QUEUE]);
  });
  afterAll(async () => {
    await app?.close();
    await withChannel('/', (ch) => ch.deleteQueue(QUEUE));
  });

  it('runs an approved Apply on the requester\'s Checkout, and records both people', async () => {
    await seedMessages('/', QUEUE, 3);
    const requester = await signedIn(rita);
    const approver = await signedIn(alan);
    const { id, checkout } = await checkoutWithDiscards(requester, 'prod', [`${QUEUE}-0`, `${QUEUE}-1`]);
    expect(checkout.applyConfirmation).toEqual({ typeQueueName: true, approvalRequired: true });

    // The requester cannot Apply alone.
    const refused = await requester.post(`/api/checkouts/${id}/apply`, { confirm: true, confirmQueueName: QUEUE });
    expect([refused.status, refused.body.error.code]).toEqual([409, 'approval_required']);

    // The request needs the same confirmation as the Apply.
    const untyped = await requestApproval(requester, id, null);
    expect([untyped.status, untyped.body.error.code]).toEqual([400, 'queue_name_confirmation_required']);
    const requested = await requestApproval(requester, id);
    expect(requested.status).toBe(200);
    expect(requested.body.checkout.status).toBe('awaiting_approval');
    expect(requested.body.checkout.approvalRequest).toMatchObject({ requestedAt: expect.any(String) });

    // The Decisions are frozen while it waits.
    const frozen = await requester.post(`/api/checkouts/${id}/decisions`, {
      handles: [requested.body.checkout.messages[2].handle],
      decision: DISCARD,
    });
    expect([frozen.status, frozen.body.error.code]).toEqual([409, 'awaiting_approval']);
    // The heartbeat keeps it alive.
    expect((await requester.post(`/api/checkouts/${id}/heartbeat`)).body.checkout.status).toBe('awaiting_approval');

    // The approver finds it, reads it read-only, and approves it.
    const list = await approver.get('/api/approvals');
    expect(list.status).toBe(200);
    expect(list.body.approvals).toEqual([
      expect.objectContaining({
        checkoutId: id,
        requester: 'rita@example.com',
        profile: 'prod',
        vhost: '/',
        queue: QUEUE,
        requestedAt: expect.any(String),
        waitingMs: expect.any(Number),
        remainingMs: expect.any(Number),
        decisionSummary: expect.arrayContaining([
          expect.objectContaining({ kind: 'discard', count: 2 }),
          expect.objectContaining({ kind: 'keep', count: 1 }),
        ]),
      }),
    ]);
    const read = await approver.get(`/api/approvals/${id}`);
    expect(read.status).toBe(200);
    expect(read.body.checkout).toMatchObject({ id, status: 'awaiting_approval', operator: 'rita@example.com', heldCount: 3 });
    const handle = read.body.checkout.messages[0].handle;
    const message = await approver.get(`/api/approvals/${id}/messages/${handle}`);
    expect([message.status, message.body.message.messageId]).toEqual([200, `${QUEUE}-0`]);
    const [a, b] = read.body.checkout.messages.map((m: any) => m.handle);
    const compared = await approver.get(`/api/approvals/${id}/compare?a=${a}&b=${b}`);
    expect(compared.status).toBe(200);
    expect([compared.body.left.messageId, compared.body.right.messageId]).toEqual([`${QUEUE}-0`, `${QUEUE}-1`]);
    expect(compared.body.diff.properties).toContainEqual({
      name: 'messageId',
      status: 'changed',
      left: `${QUEUE}-0`,
      right: `${QUEUE}-1`,
    });
    const twice = await approver.get(`/api/approvals/${id}/compare?a=${a}&b=${a}`);
    expect([twice.status, twice.body.error.code]).toEqual([400, 'invalid_request']);
    // The owner-only routes stay owner-only.
    expect((await approver.get(`/api/checkouts/${id}`)).body.error.code).toBe('not_checkout_owner');

    for (const confirmQueueName of [undefined, 'approval.dl']) {
      const wrong = await approver.post(`/api/approvals/${id}/approve`, { confirmQueueName });
      expect([wrong.status, wrong.body.error.code]).toEqual([400, 'queue_name_confirmation_required']);
    }
    const approved = await approver.post(`/api/approvals/${id}/approve`, { confirmQueueName: QUEUE });
    expect(approved.status).toBe(200);
    expect(approved.body.outcomes.map((o: any) => [o.messageId, o.status])).toEqual([
      [`${QUEUE}-0`, 'done'],
      [`${QUEUE}-1`, 'done'],
      [`${QUEUE}-2`, 'kept'],
    ]);
    expect(await readyMessageIds('/', QUEUE)).toEqual([`${QUEUE}-2`]);

    // The requester sees the outcome in their Checkout.
    const after = (await requester.get(`/api/checkouts/${id}`)).body.checkout;
    expect([after.status, after.endReason]).toEqual(['ended', 'applied']);
    expect(after.lastApply).toMatchObject({ approvedBy: 'alan@example.com' });
    expect(after.lastApply.outcomes).toHaveLength(3);

    const entries = (await requester.get(`/api/audit-entries?checkoutId=${id}`)).body.entries;
    expect(entries).toHaveLength(2);
    for (const entry of entries) {
      expect(entry).toMatchObject({
        operatorId: 'rita-sub',
        operatorName: 'rita@example.com',
        role: 'operator',
        approverId: 'alan-sub',
        approverName: 'alan@example.com',
        outcome: 'done',
      });
    }
  });

  it('refuses self-approval, and keeps the request out of the requester\'s own list', async () => {
    await seedMessages('/', QUEUE, 1);
    const requester = await signedIn(rita);
    const { id } = await checkoutWithDiscards(requester, 'prod', [`${QUEUE}-0`]);
    expect((await requestApproval(requester, id)).status).toBe(200);

    expect((await requester.get('/api/approvals')).body.approvals).toEqual([]);
    for (const res of [
      await requester.get(`/api/approvals/${id}`),
      await requester.post(`/api/approvals/${id}/approve`, { confirmQueueName: QUEUE }),
    ]) {
      expect([res.status, res.body.error.code]).toEqual([403, 'cannot_approve_own_apply']);
    }
    expect(await readyMessageIds('/', QUEUE)).toEqual([]);
  });

  it('keeps the waiting Checkout from a viewer and from an Operator of another profile', async () => {
    await seedMessages('/', QUEUE, 1);
    const requester = await signedIn(rita);
    const { id, messages } = await checkoutWithDiscards(requester, 'prod', [`${QUEUE}-0`]);
    expect((await requestApproval(requester, id)).status).toBe(200);

    for (const [identity, code] of [
      [vera, 'role_required'],
      [sam, 'no_role_on_profile'],
    ] as const) {
      const browser = await signedIn(identity);
      expect((await browser.get('/api/approvals')).body.approvals).toEqual([]);
      for (const res of [
        await browser.get(`/api/approvals/${id}`),
        await browser.get(`/api/approvals/${id}/messages/${messages[0].handle}`),
        await browser.get(`/api/approvals/${id}/compare?a=${messages[0].handle}&b=${messages[0].handle}`),
        await browser.post(`/api/approvals/${id}/approve`, { confirmQueueName: QUEUE }),
      ]) {
        expect([res.status, res.body.error.code]).toEqual([403, code]);
      }
    }
    // An `admin` may approve too.
    expect((await (await signedIn(ada)).get('/api/approvals')).body.approvals.map((a: any) => a.checkoutId)).toEqual([id]);
    expect(await readyMessageIds('/', QUEUE)).toEqual([]);
  });

  it('lets the requester withdraw, change the Decisions and request again', async () => {
    await seedMessages('/', QUEUE, 2);
    const requester = await signedIn(rita);
    const approver = await signedIn(alan);
    const { id, messages } = await checkoutWithDiscards(requester, 'prod', [`${QUEUE}-0`]);
    expect((await requestApproval(requester, id)).status).toBe(200);

    const withdrawn = await requester.request('DELETE', `/api/checkouts/${id}/approval-request`);
    expect(withdrawn.status).toBe(200);
    expect(withdrawn.body.checkout).toMatchObject({ status: 'active', approvalRequest: null });
    expect((await approver.get('/api/approvals')).body.approvals).toEqual([]);
    const gone = await approver.post(`/api/approvals/${id}/approve`, { confirmQueueName: QUEUE });
    expect([gone.status, gone.body.error.code]).toEqual([409, 'not_awaiting_approval']);
    const again = await requester.request('DELETE', `/api/checkouts/${id}/approval-request`);
    expect([again.status, again.body.error.code]).toEqual([409, 'not_awaiting_approval']);

    const second = messages.find((m) => m.messageId === `${QUEUE}-1`).handle;
    expect((await requester.post(`/api/checkouts/${id}/decisions`, { handles: [second], decision: DISCARD })).status).toBe(200);
    expect((await requestApproval(requester, id)).body.checkout.status).toBe('awaiting_approval');
    const approved = await approver.post(`/api/approvals/${id}/approve`, { confirmQueueName: QUEUE });
    expect(approved.body.outcomes.filter((o: any) => o.status === 'done')).toHaveLength(2);
    expect(await readyMessageIds('/', QUEUE)).toEqual([]);
  });

  it('returns a rejected request to staging with the reason, until the next request', async () => {
    await seedMessages('/', QUEUE, 2);
    const requester = await signedIn(rita);
    const approver = await signedIn(alan);
    const { id, messages } = await checkoutWithDiscards(requester, 'prod', [`${QUEUE}-0`]);
    expect((await requestApproval(requester, id)).status).toBe(200);

    for (const body of [{}, { reason: '' }, { reason: '   ' }, { reason: 42 }]) {
      const unexplained = await approver.post(`/api/approvals/${id}/reject`, body);
      expect([unexplained.status, unexplained.body.error.code]).toEqual([400, 'invalid_request']);
    }
    // The requester may not reject their own request either.
    const own = await requester.post(`/api/approvals/${id}/reject`, { reason: 'no' });
    expect([own.status, own.body.error.code]).toEqual([403, 'cannot_approve_own_apply']);

    const rejected = await approver.post(`/api/approvals/${id}/reject`, { reason: 'Keep order 7, it is still valid' });
    expect(rejected.status).toBe(200);
    expect(rejected.body.checkout).toMatchObject({ status: 'active', approvalRequest: null });
    expect((await approver.get('/api/approvals')).body.approvals).toEqual([]);

    // The requester sees why, and who rejected it.
    const seen = (await requester.get(`/api/checkouts/${id}`)).body.checkout;
    expect(seen).toMatchObject({
      status: 'active',
      rejection: { reason: 'Keep order 7, it is still valid', rejectedBy: 'alan@example.com', at: expect.any(String) },
    });
    // Rejecting or approving it again: nothing waits, and the message says why.
    for (const res of [
      await approver.post(`/api/approvals/${id}/reject`, { reason: 'again' }),
      await approver.post(`/api/approvals/${id}/approve`, { confirmQueueName: QUEUE }),
      await approver.get(`/api/approvals/${id}`),
    ]) {
      expect([res.status, res.body.error.code]).toEqual([409, 'not_awaiting_approval']);
      expect(res.body.error.message).toMatch(/alan@example\.com rejected/);
    }

    // The requester edits the Decisions and asks again; the rejection is gone.
    const second = messages.find((m) => m.messageId === `${QUEUE}-1`).handle;
    expect((await requester.post(`/api/checkouts/${id}/decisions`, { handles: [second], decision: DISCARD })).status).toBe(200);
    expect((await requester.get(`/api/checkouts/${id}`)).body.checkout.rejection).not.toBeNull();
    const again = await requestApproval(requester, id);
    expect(again.body.checkout).toMatchObject({ status: 'awaiting_approval', rejection: null });
    const approved = await approver.post(`/api/approvals/${id}/approve`, { confirmQueueName: QUEUE });
    expect(approved.body.outcomes.filter((o: any) => o.status === 'done')).toHaveLength(2);
  });

  it('cancels the request when the requester ends the Checkout, and tells a late approver why', async () => {
    await seedMessages('/', QUEUE, 1);
    const requester = await signedIn(rita);
    const approver = await signedIn(alan);
    const { id } = await checkoutWithDiscards(requester, 'prod', [`${QUEUE}-0`]);
    expect((await requestApproval(requester, id)).status).toBe(200);
    expect((await approver.get(`/api/approvals/${id}`)).status).toBe(200);

    expect((await requester.request('DELETE', `/api/checkouts/${id}`)).body.checkout.status).toBe('ended');
    expect((await approver.get('/api/approvals')).body.approvals).toEqual([]);
    for (const res of [
      await approver.get(`/api/approvals/${id}`),
      await approver.post(`/api/approvals/${id}/approve`, { confirmQueueName: QUEUE }),
    ]) {
      expect([res.status, res.body.error.code]).toEqual([409, 'not_awaiting_approval']);
      expect(res.body.error.message).toMatch(/rita@example\.com ended the Checkout, which cancelled the request/);
    }
    expect(await readyMessageIds('/', QUEUE)).toEqual([`${QUEUE}-0`]);
  });

  it('cancels the request when the Checkout becomes a Lost Checkout', async () => {
    await seedMessages('/', QUEUE, 1);
    const requester = await signedIn(rita);
    const approver = await signedIn(alan);
    const { id } = await checkoutWithDiscards(requester, 'prod', [`${QUEUE}-0`]);
    expect((await requestApproval(requester, id)).status).toBe(200);

    const [name] = await eventually(async () => {
      const found = await checkoutConnectionNames(QUEUE);
      expect(found).toHaveLength(1);
      return found;
    });
    await closeConnection(name!);
    await eventually(async () => expect((await requester.get(`/api/checkouts/${id}`)).body.checkout.status).toBe('lost'));

    expect((await approver.get('/api/approvals')).body.approvals).toEqual([]);
    const late = await approver.post(`/api/approvals/${id}/approve`, { confirmQueueName: QUEUE });
    expect([late.status, late.body.error.code]).toEqual([409, 'not_awaiting_approval']);
    expect(late.body.error.message).toMatch(/the Checkout was lost .*, which cancelled the request/);
    expect(await readyMessageIds('/', QUEUE)).toEqual([`${QUEUE}-0`]);
  });

  describe('races: the first of approve, withdraw, reject and the end wins', () => {
    it('approve and withdraw at once: exactly one wins', async () => {
      await seedMessages('/', QUEUE, 1);
      const requester = await signedIn(rita);
      const approver = await signedIn(alan);
      const { id } = await checkoutWithDiscards(requester, 'prod', [`${QUEUE}-0`]);
      expect((await requestApproval(requester, id)).status).toBe(200);

      const [approved, withdrawn] = await Promise.all([
        approver.post(`/api/approvals/${id}/approve`, { confirmQueueName: QUEUE }),
        requester.request('DELETE', `/api/checkouts/${id}/approval-request`),
      ]);
      expect([approved.status, withdrawn.status].sort()).toEqual([200, 409]);
      const loser = approved.status === 409 ? approved : withdrawn;
      expect(loser.body.error.code).toBe('not_awaiting_approval');

      const entries = (await requester.get(`/api/audit-entries?checkoutId=${id}`)).body.entries;
      if (approved.status === 200) {
        expect(loser.body.error.message).toMatch(/alan@example\.com approved it/);
        expect(entries).toHaveLength(1);
        expect(await readyMessageIds('/', QUEUE)).toEqual([]);
      } else {
        expect(loser.body.error.message).toMatch(/rita@example\.com withdrew the request/);
        expect(entries).toEqual([]);
        expect(withdrawn.body.checkout).toMatchObject({ status: 'active', heldCount: 1 });
      }
    });

    it('two approvers at once: the Apply runs once', async () => {
      await seedMessages('/', QUEUE, 2);
      const requester = await signedIn(rita);
      const approvers = [await signedIn(alan), await signedIn(ada)];
      const { id } = await checkoutWithDiscards(requester, 'prod', [`${QUEUE}-0`, `${QUEUE}-1`]);
      expect((await requestApproval(requester, id)).status).toBe(200);

      const results = await Promise.all(
        approvers.map((a) => a.post(`/api/approvals/${id}/approve`, { confirmQueueName: QUEUE })),
      );
      expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
      const winner = results.find((r) => r.status === 200)!;
      const loser = results.find((r) => r.status === 409)!;
      expect(loser.body.error.code).toBe('not_awaiting_approval');
      expect(loser.body.error.message).toMatch(/(alan|ada)@example\.com approved it/);
      expect(winner.body.outcomes.filter((o: any) => o.status === 'done')).toHaveLength(2);
      expect((await requester.get(`/api/audit-entries?checkoutId=${id}`)).body.entries).toHaveLength(2);
      expect(await readyMessageIds('/', QUEUE)).toEqual([]);
    });

    it('approve and the Checkout ending at once: the Apply runs fully or not at all', async () => {
      await seedMessages('/', QUEUE, 2);
      const requester = await signedIn(rita);
      const approver = await signedIn(alan);
      const { id } = await checkoutWithDiscards(requester, 'prod', [`${QUEUE}-0`, `${QUEUE}-1`]);
      expect((await requestApproval(requester, id)).status).toBe(200);

      const [approved, ended] = await Promise.all([
        approver.post(`/api/approvals/${id}/approve`, { confirmQueueName: QUEUE }),
        requester.request('DELETE', `/api/checkouts/${id}`),
      ]);
      expect(ended.status).toBe(200);
      const entries = (await requester.get(`/api/audit-entries?checkoutId=${id}`)).body.entries;
      if (approved.status === 200) {
        expect(ended.body.checkout.endReason).toBe('applied');
        expect(entries.map((e: any) => e.outcome)).toEqual(['done', 'done']);
        expect(await readyMessageIds('/', QUEUE)).toEqual([]);
      } else {
        expect(approved.body.error.code).toBe('not_awaiting_approval');
        expect(ended.body.checkout.endReason).toBe('operator');
        expect(entries).toEqual([]);
        expect(await readyMessageIds('/', QUEUE)).toEqual([`${QUEUE}-0`, `${QUEUE}-1`]);
      }
    });
  });

  it('needs no Approval for a Checkout whose Decisions are all Keep', async () => {
    await seedMessages('/', QUEUE, 1);
    const requester = await signedIn(rita);
    const { id, checkout } = await checkoutWithDiscards(requester, 'prod', []);
    expect(checkout.applyConfirmation).toEqual({ typeQueueName: false, approvalRequired: false });
    const res = await requestApproval(requester, id);
    expect([res.status, res.body.error.code]).toEqual([409, 'approval_not_required']);
  });

  it('keeps the v0.2 behaviour with requireApproval: false', async () => {
    await seedMessages('/', QUEUE, 1);
    const requester = await signedIn(rita);
    const { id, checkout } = await checkoutWithDiscards(requester, 'lax', [`${QUEUE}-0`]);
    expect(checkout.applyConfirmation).toEqual({ typeQueueName: true, approvalRequired: false });
    const applied = await requester.post(`/api/checkouts/${id}/apply`, { confirm: true, confirmQueueName: QUEUE });
    expect(applied.status).toBe(200);
    expect(await readyMessageIds('/', QUEUE)).toEqual([]);
    const [entry] = (await requester.get(`/api/audit-entries?checkoutId=${id}`)).body.entries;
    expect(entry).toMatchObject({ operatorId: 'rita-sub', approverId: null, approverName: null });
  });
});

describe('Approval and the time limit', () => {
  let app: TestApp;
  let baseUrl: string;

  beforeAll(async () => {
    await withChannel('/', (ch) => ch.assertQueue(QUEUE, { durable: true }));
    const port = await closedPort();
    baseUrl = `http://127.0.0.1:${port}`;
    app = await startApp({
      profiles: [testProfile({ name: 'prod', protected: true, roles: { operator: ['oncall'] } })],
      port,
      env: teamModeEnv(baseUrl),
      checkoutTiming: { timeLimitMs: 4_000, heartbeatWindowMs: 60_000 },
    });
  });
  afterAll(async () => {
    await app?.close();
    await purgeQueues('/', [QUEUE]);
    await withChannel('/', (ch) => ch.deleteQueue(QUEUE));
  });

  it('cancels a waiting request when the Checkout reaches its time limit', async () => {
    await seedMessages('/', QUEUE, 1);
    const requester = new TestBrowser(baseUrl);
    await requester.signIn(rita);
    const approver = new TestBrowser(baseUrl);
    await approver.signIn(alan);
    const started = await requester.post(checkoutPath('prod'));
    const { id, messages } = started.body.checkout;
    await requester.post(`/api/checkouts/${id}/decisions`, { handles: [messages[0].handle], decision: DISCARD });
    const requested = await requester.post(`/api/checkouts/${id}/approval-request`, { confirm: true, confirmQueueName: QUEUE });
    expect(requested.body.checkout.status).toBe('awaiting_approval');
    // The waiting screen and the approvers' list both show the time left.
    expect(requested.body.checkout.remainingMs).toBeGreaterThan(0);
    expect((await approver.get('/api/approvals')).body.approvals[0].remainingMs).toBeGreaterThan(0);

    const ended = await eventually(async () => {
      const res = await requester.get(`/api/checkouts/${id}`);
      expect(res.body.checkout.status).toBe('ended');
      return res.body.checkout;
    }, 10_000);
    expect([ended.endReason, ended.approvalRequest]).toEqual(['time-limit', null]);
    expect((await approver.get('/api/approvals')).body.approvals).toEqual([]);
    const late = await approver.post(`/api/approvals/${id}/approve`, { confirmQueueName: QUEUE });
    expect([late.status, late.body.error.code]).toEqual([409, 'not_awaiting_approval']);
    expect(late.body.error.message).toMatch(/reached its time limit, which cancelled the request/);
    expect(await readyMessageIds('/', QUEUE)).toEqual([`${QUEUE}-0`]);
  });
});
