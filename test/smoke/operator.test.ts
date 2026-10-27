// kind smoke test (spec #16, seam 3): the chart installed from this checkout
// into a namespace enforcing the restricted Pod Security Standard, used by an
// Operator over a port-forward. The steps build on each other and run in
// order. scripts/kind-smoke.mjs builds the cluster first (npm run test:smoke).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TestBrowser } from '../integration/oidc-provider.js';
import {
  deadLetterOrder,
  eventually,
  portForward,
  readyPod,
  replacementOf,
  volveranPods,
  type PortForward,
  type VolveranPod,
} from './cluster.js';
import { appNamespace, depsNamespace, helmInstallArgs, kubectl, ports, releaseName, run, smokeDir } from './kind-env.mjs';

const appUrl = `http://127.0.0.1:${ports.app}`;
const operator = { sub: 'smoke-operator', email: 'operator@example.com', name: 'Smoke Operator' };
const messageId = `smoke-${Date.now()}`;
const payload = JSON.stringify({ order: messageId, total: 42 });
const checkoutPath = `/api/profiles/smoke/vhosts/%2F/queues/orders.dlq/checkouts`;

let app: PortForward | undefined;
const forwards: PortForward[] = [];

/** (Re)opens the port-forward to Volverán's Service and waits until it serves. */
async function forwardApp() {
  await app?.close();
  app = await portForward(appNamespace, `service/${releaseName}`, ports.app, 8080);
  await eventually(async () => {
    const res = await fetch(`${appUrl}/readyz`);
    if (res.status !== 200) throw new Error(`/readyz answered ${res.status}`);
  }, 60_000);
}

/** Signs the Operator in through the mock provider; the browser reaches it at its port-forward. */
async function signIn(): Promise<TestBrowser> {
  const browser = new TestBrowser(appUrl);
  const authorize = new URL(await browser.startSignIn());
  authorize.protocol = 'https:';
  authorize.host = `127.0.0.1:${ports.oidc}`;
  const back = await browser.get(await browser.approveAtProvider(authorize.href, operator));
  expect(back.status).toBe(302);
  return browser;
}

/** The Operator's view of an Audit Entry, from a fresh session. */
async function auditEntry(browser: TestBrowser, id: number) {
  const res = await browser.get(`/api/audit-entries/${id}`);
  expect(res.status).toBe(200);
  return res.body.entry;
}

beforeAll(async () => {
  forwards.push(await portForward(depsNamespace, 'service/oidc', ports.oidc, 8080));
  forwards.push(await portForward(depsNamespace, 'service/rabbitmq', ports.management, 15672));
  await forwardApp();
});

afterAll(async () => {
  await app?.close();
  await Promise.all(forwards.map((f) => f.close()));
});

describe('Volverán on kind', () => {
  let discardEntryId: number;

  it('runs Ready in a namespace that enforces the restricted Pod Security Standard', () => {
    const labels = JSON.parse(kubectl(['get', 'namespace', appNamespace, '-o', 'json'])).metadata.labels;
    expect(labels['pod-security.kubernetes.io/enforce']).toBe('restricted');
    expect(readyPod().ready).toBe(true);
    // A pod the admission controller refused leaves FailedCreate events on its ReplicaSet.
    const refused = JSON.parse(kubectl(['-n', appNamespace, 'get', 'events', '--field-selector', 'reason=FailedCreate', '-o', 'json']));
    expect(refused.items.map((e: any) => e.message)).toEqual([]);
  });

  it('signs an Operator in through the mock OIDC provider', async () => {
    const browser = await signIn();
    const session = await browser.get('/api/session');
    expect(session.status).toBe(200);
    expect(session.body).toMatchObject({ mode: 'team', operator: 'operator@example.com', operatorId: 'smoke-operator' });
  });

  it('Applies a Discard from a Checkout on a dead-letter queue', async () => {
    await deadLetterOrder(messageId, payload);
    const browser = await signIn();

    const started = await eventually(async () => {
      const res = await browser.post(checkoutPath);
      expect(res.status).toBe(201);
      if (!res.body.checkout.messages.some((m: any) => m.messageId === messageId)) {
        await browser.post(`/api/checkouts/${res.body.checkout.id}/end`);
        throw new Error(`${messageId} is not in the Checkout yet`);
      }
      return res;
    }, 30_000);
    const { checkout } = started.body;
    const handle = checkout.messages.find((m: any) => m.messageId === messageId).handle;
    const decided = await browser.post(`/api/checkouts/${checkout.id}/decisions`, {
      handles: [handle],
      decision: { kind: 'discard', reason: 'smoke test' },
    });
    expect(decided.status).toBe(200);
    const applied = await browser.post(`/api/checkouts/${checkout.id}/apply`, { confirm: true });
    expect(applied.status).toBe(200);

    const { entries } = (await browser.get(`/api/audit-entries?checkoutId=${checkout.id}`)).body;
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ action: 'discard', messageId, queue: 'orders.dlq', operatorName: 'operator@example.com', outcome: 'done' });
    discardEntryId = entries[0].id;
    const entry = await auditEntry(browser, discardEntryId);
    expect(Buffer.from(entry.message.body, 'base64').toString()).toBe(payload);
  });

  it('keeps the Audit Entry and the Discarded body when the pod is deleted', async () => {
    const before = readyPod();
    kubectl(['-n', appNamespace, 'delete', 'pod', before.name, '--wait=true']);
    await replacementOf(before);
    await forwardApp();

    // A restart signs everyone out, so this is a new session.
    const entry = await auditEntry(await signIn(), discardEntryId);
    expect(entry).toMatchObject({ action: 'discard', messageId, operatorName: 'operator@example.com', outcome: 'done' });
    expect(Buffer.from(entry.message.body, 'base64').toString()).toBe(payload);
  });

  it('rolls the pod on helm upgrade with a changed Broker Profile', async () => {
    const before: VolveranPod = readyPod();
    run('helm', helmInstallArgs([`${smokeDir}/values-upgrade.yaml`]));
    const after = await replacementOf(before);
    expect(volveranPods().map((p) => p.uid)).toEqual([after.uid]);
    await forwardApp();

    const { profiles } = (await (await signIn()).get('/api/profiles')).body;
    expect(profiles.map((p: any) => [p.name, p.defaultQueueFilter])).toEqual([['smoke', 'orders.*']]);
  });
});
