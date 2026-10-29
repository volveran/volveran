// Canary Replay with Approval (Team Mode, against the real broker): on a
// Protected Profile the request for Approval carries the Canary, frozen with
// the Decisions and the rate, and the approver sees it. Approving runs the
// Canary; then the requester (under /api/checkouts/) or the approver (under
// /api/approvals/) continues or stops, with no second Approval. A Broker
// Profile's `canary.requiredAbove` refuses a request with more Replays and no
// Canary.
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  appliedCheckout,
  closedPort,
  deadLetter,
  deadLetterRoutes,
  eventually,
  fixtureQueues,
  purgeQueues,
  readyMessageIds,
  startApp,
  testProfile,
  type TestApp,
} from './harness.js';
import { teamModeEnv, TestBrowser, type TestIdentity } from './oidc-provider.js';

const route = deadLetterRoutes.classic;
const checkoutPath = (profile: string) => `/api/profiles/${profile}/vhosts/%2F/queues/${encodeURIComponent(route.dlq)}/checkouts`;
const REPLAY = { kind: 'replay' };

const rita = { sub: 'rita-sub', email: 'rita@example.com', groups: ['oncall'] };
const alan = { sub: 'alan-sub', email: 'alan@example.com', groups: ['oncall'] };
const omar = { sub: 'omar-sub', email: 'omar@example.com', groups: ['oncall'] };

describe('Canary with Approval', () => {
  let app: TestApp;
  let baseUrl: string;
  /** Checkouts to end after each test: [owner's browser, id]. */
  const open: Array<[TestBrowser, string]> = [];

  async function signedIn(identity: TestIdentity) {
    const browser = new TestBrowser(baseUrl);
    await browser.signIn(identity);
    return browser;
  }

  /** Dead-letters canary-0 .. canary-<n-1> into orders.dlq only (the other DLQs of the fanout are emptied). */
  async function deadLettered(n: number) {
    await deadLetter(
      route,
      Array.from({ length: n }, (_, i) => ({ body: `order ${i}`, options: { messageId: `canary-${i}` } })),
    );
    await purgeQueues('/', route.dlqs.filter((q) => q !== route.dlq));
  }

  /** Starts a Checkout of orders.dlq on `profile` as `browser`, with every Message's Decision Replay. */
  async function checkoutWithReplays(browser: TestBrowser, profile = 'prod') {
    const started = await browser.post(checkoutPath(profile));
    expect(started.status).toBe(201);
    const { id, messages } = started.body.checkout;
    open.push([browser, id]);
    const handles = messages.map((m: any) => m.handle);
    expect((await browser.post(`/api/checkouts/${id}/decisions`, { handles, decision: REPLAY })).status).toBe(200);
    const handle = (messageId: string) => messages.find((m: any) => m.messageId === messageId).handle as number;
    return { id: id as string, handle };
  }

  const requestApproval = (browser: TestBrowser, id: string, extra: Record<string, unknown> = {}) =>
    browser.post(`/api/checkouts/${id}/approval-request`, { confirm: true, confirmQueueName: route.dlq, ...extra });
  const approve = (approver: TestBrowser, id: string) =>
    approver.post(`/api/approvals/${id}/approve`, { confirmQueueName: route.dlq });
  /** The Checkout, as the approver follows it, once its Apply waits in `phase`. */
  const approverSeesPhase = (approver: TestBrowser, id: string, phase: string) =>
    eventually(async () => {
      const { checkout } = (await approver.get(`/api/approvals/${id}`)).body;
      if (checkout.applyProgress?.phase !== phase) throw new Error(`Apply is in ${checkout.applyProgress?.phase}, not ${phase}`);
      return checkout;
    }, 15_000);
  const outcomesOf = (checkout: any) => checkout.lastApply.outcomes.map((o: any) => [o.messageId, o.status]);

  beforeAll(async () => {
    const port = await closedPort();
    baseUrl = `http://127.0.0.1:${port}`;
    app = await startApp({
      profiles: [
        testProfile({ name: 'prod', protected: true, roles: { operator: ['oncall'] } }),
        testProfile({ name: 'guarded', protected: true, roles: { operator: ['oncall'] }, canary: { requiredAbove: 1 } }),
      ],
      port,
      env: teamModeEnv(baseUrl),
      checkoutTiming: { timeLimitMs: 120_000 },
    });
  });
  afterEach(async () => {
    for (const [browser, id] of open.splice(0)) await browser.request('DELETE', `/api/checkouts/${id}`);
    await purgeQueues('/', [...fixtureQueues]);
  });
  afterAll(async () => {
    await app?.close();
  });

  it('a request with a Canary is approved, the Canary runs, the approver continues, and every Audit Entry names both people', async () => {
    await deadLettered(3);
    const owner = await signedIn(rita);
    const approver = await signedIn(alan);
    const { id, handle } = await checkoutWithReplays(owner);

    const requested = await requestApproval(owner, id, { canary: { handle: handle('canary-1') } });
    expect(requested.status).toBe(200);
    const canary = { handle: handle('canary-1'), messageId: 'canary-1' };
    expect(requested.body.checkout.approvalRequest.canary).toEqual(canary);

    // The approver sees the Canary in the list and in the request.
    const listed = (await approver.get('/api/approvals')).body.approvals;
    expect(listed.find((a: any) => a.checkoutId === id).canary).toEqual(canary);
    expect((await approver.get(`/api/approvals/${id}`)).body.checkout.approvalRequest.canary).toEqual(canary);

    expect((await approve(approver, id)).status).toBe(202);
    const watching = await approverSeesPhase(approver, id, 'canary_watch');
    expect(watching.canary).toMatchObject({ handle: handle('canary-1'), messageId: 'canary-1', status: 'watching' });
    expect(watching.heldCount).toBe(2);
    expect(await readyMessageIds('/', route.workQueue)).toEqual(['canary-1']);

    // Continuing needs no second Approval.
    const continued = await approver.post(`/api/approvals/${id}/apply/continue`);
    expect(continued.status).toBe(200);
    const applied = await appliedCheckout(owner, id);
    expect(outcomesOf(applied)).toEqual([
      ['canary-0', 'done'],
      ['canary-1', 'done'],
      ['canary-2', 'done'],
    ]);
    expect(applied.lastApply.approvedBy).toBe('alan@example.com');

    const entries = (await owner.get(`/api/audit-entries?checkoutId=${id}`)).body.entries as any[];
    expect(entries).toHaveLength(3);
    for (const entry of entries) {
      expect(entry).toMatchObject({ operatorName: 'rita@example.com', approverName: 'alan@example.com' });
    }
    expect(entries.find((e) => e.messageId === 'canary-1')).toMatchObject({ canary: true });
  });

  it('the requester can stop after an approved Canary; a third Operator cannot continue', async () => {
    await deadLettered(3);
    const owner = await signedIn(rita);
    const approver = await signedIn(alan);
    const other = await signedIn(omar);
    const { id } = await checkoutWithReplays(owner);
    expect((await requestApproval(owner, id, { canary: true })).status).toBe(200);
    expect((await approve(approver, id)).status).toBe(202);
    await approverSeesPhase(approver, id, 'canary_watch');

    const refused = [
      await other.post(`/api/approvals/${id}/apply/continue`),
      await other.post(`/api/checkouts/${id}/apply/continue`),
      await approver.post(`/api/checkouts/${id}/apply/continue`),
    ];
    expect(refused.map((r) => [r.status, r.body.error.code])).toEqual([
      [403, 'not_checkout_owner'],
      [403, 'not_checkout_owner'],
      [403, 'not_checkout_owner'],
    ]);

    expect((await owner.post(`/api/checkouts/${id}/apply/stop`)).status).toBe(200);
    const applied = await appliedCheckout(owner, id);
    expect(outcomesOf(applied)).toEqual([
      ['canary-0', 'done'],
      ['canary-1', 'not-attempted'],
      ['canary-2', 'not-attempted'],
    ]);
    expect(await readyMessageIds('/', route.dlq)).toEqual(['canary-1', 'canary-2']);
    // Nothing is left to continue.
    expect((await approver.post(`/api/approvals/${id}/apply/continue`)).status).toBe(409);
  });

  it('refuses a request with more Replays than requiredAbove and no Canary (canary_required), and freezes a valid Canary', async () => {
    await deadLettered(2);
    const owner = await signedIn(rita);
    const { id } = await checkoutWithReplays(owner, 'guarded');

    const refused = await requestApproval(owner, id);
    expect(refused.status).toBe(400);
    expect(refused.body.error).toMatchObject({ code: 'canary_required', requiredAbove: 1 });
    expect((await owner.get(`/api/checkouts/${id}`)).body.checkout.status).toBe('active');

    const badHandle = await requestApproval(owner, id, { canary: { handle: 999 } });
    expect(badHandle.status).toBe(400);
    expect(badHandle.body.error.code).toBe('invalid_request');

    const requested = await requestApproval(owner, id, { canary: true });
    expect(requested.status).toBe(200);
    expect(requested.body.checkout.approvalRequest.canary.messageId).toBe('canary-0');
  });

  it('a request without a Canary has none, and its approved Apply runs straight through', async () => {
    await deadLettered(2);
    const owner = await signedIn(rita);
    const approver = await signedIn(alan);
    const { id } = await checkoutWithReplays(owner);
    expect((await requestApproval(owner, id)).body.checkout.approvalRequest.canary).toBeNull();
    expect((await approve(approver, id)).status).toBe(202);
    const applied = await appliedCheckout(owner, id);
    expect(outcomesOf(applied)).toEqual([
      ['canary-0', 'done'],
      ['canary-1', 'done'],
    ]);
    expect(applied.canary).toBeNull();
  });
});
