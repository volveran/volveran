// kind smoke test, second run (#92, #121): several Replicas on PostgreSQL under the restricted
// Pod Security Standard, each pod reached on a port-forward of its own, so that a request goes
// to the pod the test means. The steps build on each other and run in order.
// scripts/kind-smoke.mjs builds the cluster and installs the release first.
import { spawn } from 'node:child_process';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TestBrowser } from '../integration/oidc-provider.js';
import {
  connectFromPod,
  connectFromProbe,
  crash,
  deadLetterOrder,
  eventually,
  portForward,
  readyPods,
  startProbe,
  stopProbe,
  volveranPods,
  type PortForward,
  type VolveranPod,
} from './cluster.js';
import { appNamespace, depsNamespace, forwardingPort, helmInstallArgs, kubectl, ports, releaseName, replicasValues, smokeDir } from './kind-env.mjs';

const operator = { sub: 'smoke-operator', email: 'operator@example.com', name: 'Smoke Operator', groups: ['smoke-triage'] };
const checkoutPath = `/api/profiles/smoke/vhosts/%2F/queues/orders.dlq/checkouts`;

interface Served extends VolveranPod {
  browser: TestBrowser;
}

/** The Operator's cookies, shared by every pod's browser: the session is in the database. */
const cookies = new Map<string, string>();
let appForwards: PortForward[] = [];
const forwards: PortForward[] = [];

/**
 * A port-forward and a browser for each of `count` Ready pods. The first pod takes the port of
 * the OIDC redirect URL, so that a sign-in comes back to it.
 */
async function servePods(count: number): Promise<Served[]> {
  await Promise.all(appForwards.map((f) => f.close()));
  appForwards = [];
  const pods = await readyPods(count);
  return Promise.all(
    pods.map(async (pod, i) => {
      const port = ports.app + i;
      appForwards.push(await portForward(appNamespace, `pod/${pod.name}`, port, 8080));
      return { ...pod, browser: new TestBrowser(`http://127.0.0.1:${port}`, cookies) };
    }),
  );
}

async function signIn(browser: TestBrowser): Promise<void> {
  const authorize = new URL(await browser.startSignIn());
  authorize.protocol = 'https:';
  authorize.host = `127.0.0.1:${ports.oidc}`;
  const back = await browser.get(await browser.approveAtProvider(authorize.href, operator));
  expect(back.status).toBe(302);
}

/** Dead-letters a new Message and starts a Checkout holding it, through this browser. */
async function startCheckoutWithNewMessage(browser: TestBrowser, label: string) {
  const messageId = `smoke-${label}-${Date.now()}`;
  const payload = JSON.stringify({ order: messageId });
  await deadLetterOrder(messageId, payload);
  const checkout = await eventually(async () => {
    const res = await browser.post(checkoutPath);
    expect(res.status).toBe(201);
    if (!res.body.checkout.messages.some((m: any) => m.messageId === messageId)) {
      await browser.post(`/api/checkouts/${res.body.checkout.id}/end`);
      throw new Error(`${messageId} is not in the Checkout yet`);
    }
    return res.body.checkout;
  }, 60_000);
  return { checkout, messageId, payload, handle: checkout.messages.find((m: any) => m.messageId === messageId).handle as string };
}

const viewOf = async (browser: TestBrowser, id: string) => (await browser.get(`/api/checkouts/${id}`)).body.checkout;

/** Waits until this browser's Replica reports the Checkout lost, and returns its view. */
const lostThrough = (browser: TestBrowser, id: string) =>
  eventually(async () => {
    const view = await viewOf(browser, id);
    expect(view?.status).toBe('lost');
    return view;
  }, 60_000);

/** Runs helm without blocking, so the test can watch the pods meanwhile. */
function helmAsync(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    let output = '';
    const child = spawn('helm', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.on('data', (chunk: Buffer) => (output += chunk));
    child.stderr.on('data', (chunk: Buffer) => (output += chunk));
    child.on('error', reject);
    child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`helm exited with ${code}: ${output}`))));
  });
}

beforeAll(async () => {
  forwards.push(await portForward(depsNamespace, 'service/oidc', ports.oidc, 8080));
  forwards.push(await portForward(depsNamespace, 'service/rabbitmq', ports.management, 15672));
  startProbe(depsNamespace);
  startProbe(appNamespace);
});

afterAll(async () => {
  await Promise.all([...appForwards, ...forwards].map((f) => f.close()));
  stopProbe(depsNamespace);
  stopProbe(appNamespace);
});

describe('two Replicas on kind', () => {
  let discarded: { checkoutId: string; entryId: number; payload: string };

  it('run Ready in a namespace that enforces the restricted Pod Security Standard, with a rolling update and no claim', async () => {
    const labels = JSON.parse(kubectl(['get', 'namespace', appNamespace, '-o', 'json'])).metadata.labels;
    expect(labels['pod-security.kubernetes.io/enforce']).toBe('restricted');
    await readyPods(2);
    const refused = JSON.parse(kubectl(['-n', appNamespace, 'get', 'events', '--field-selector', 'reason=FailedCreate', '-o', 'json']));
    expect(refused.items.map((e: any) => e.message)).toEqual([]);
    const { spec } = JSON.parse(kubectl(['-n', appNamespace, 'get', 'deployment', releaseName, '-o', 'json']));
    expect(spec.strategy.type).toBe('RollingUpdate');
    expect(spec.template.spec.volumes.filter((v: any) => v.persistentVolumeClaim)).toEqual([]);
  });

  it('admit only each other to the forwarding port, with no networkPolicy asked for, and leave the web port open', async () => {
    const [a, b] = await readyPods(2);
    expect(kubectl(['-n', appNamespace, 'get', 'deployment', releaseName, '-o', 'jsonpath={.spec.replicas}'])).toBe('2');
    await eventually(() => {
      expect(connectFromPod(a!, b!.ip, forwardingPort)).toBe('open');
      expect(connectFromPod(b!, a!.ip, forwardingPort)).toBe('open');
    }, 60_000);
    for (const namespace of [depsNamespace, appNamespace]) {
      expect(connectFromProbe(namespace, a!.ip, 8080)).toBe('open');
      expect(connectFromProbe(namespace, a!.ip, forwardingPort)).toBe('closed');
      expect(connectFromProbe(namespace, b!.ip, forwardingPort)).toBe('closed');
    }
  });

  it('serve one session through either pod', async () => {
    const [a, b] = await servePods(2);
    await signIn(a!.browser);
    for (const { browser } of [a!, b!]) {
      const session = await browser.get('/api/session');
      expect(session.status).toBe(200);
      expect(session.body).toMatchObject({ mode: 'team', operatorId: 'smoke-operator', roles: { smoke: 'operator' } });
    }
  });

  it('Apply a Discard with both pods serving: started on one, decided and Applied through the other', async () => {
    const [a, b] = await servePods(2);
    const { checkout, messageId, payload, handle } = await startCheckoutWithNewMessage(a!.browser, 'apply');
    const decided = await b!.browser.post(`/api/checkouts/${checkout.id}/decisions`, { handles: [handle], decision: { kind: 'discard', reason: 'smoke test' } });
    expect(decided.status).toBe(200);
    const applied = await b!.browser.post(`/api/checkouts/${checkout.id}/apply`, { confirm: true });
    expect(applied.status).toBe(202);
    const ended = await eventually(async () => {
      const view = await viewOf(a!.browser, checkout.id);
      if (view.status === 'applying' || !view.lastApply) throw new Error(`Checkout ${checkout.id} is still applying`);
      return view;
    }, 30_000);
    expect(ended.lastApply.outcomes).toMatchObject([{ handle, status: 'done' }]);
    expect((await viewOf(b!.browser, checkout.id)).lastApply.outcomes).toMatchObject([{ handle, status: 'done' }]);

    const { entries } = (await b!.browser.get(`/api/audit-entries?checkoutId=${checkout.id}`)).body;
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ action: 'discard', messageId, queue: 'orders.dlq', operatorName: 'operator@example.com', outcome: 'done' });
    discarded = { checkoutId: checkout.id, entryId: entries[0].id, payload };
    await a!.browser.post(`/api/checkouts/${checkout.id}/end`);
  });

  let liveCheckout: { id: string; messageId: string; owner: string };

  it('keep a live Checkout when the other pod is deleted, and the new pod serves it', async () => {
    const [owner, other] = await servePods(2);
    const { checkout, messageId } = await startCheckoutWithNewMessage(owner!.browser, 'live');
    liveCheckout = { id: checkout.id, messageId, owner: owner!.name };

    kubectl(['-n', appNamespace, 'delete', 'pod', other!.name, '--wait=true']);
    expect((await viewOf(owner!.browser, checkout.id)).status).toBe('active');

    await eventually(async () => {
      const pods = await readyPods(2);
      if (pods.some((p) => p.uid === other!.uid)) throw new Error('not replaced yet');
    });
    const served = await servePods(2);
    const replacement = served.find((p) => p.name !== owner!.name)!;
    const view = await viewOf(replacement.browser, checkout.id);
    expect(view.status).toBe('active');
    expect(view.messages.map((m: any) => m.messageId)).toContain(messageId);
  });

  it('show the Lost Checkout through the survivor when the Owner Replica dies, keep the Audit Entries, and give the Messages back', async () => {
    const served = await servePods(2);
    const owner = served.find((p) => p.name === liveCheckout.owner)!;
    const survivor = served.find((p) => p.name !== liveCheckout.owner)!;

    crash(owner);

    const lost = await lostThrough(survivor.browser, liveCheckout.id);
    expect(lost.lostReason).toMatch(/Replica/);
    expect(lost.messages).toEqual([]);

    const entry = (await survivor.browser.get(`/api/audit-entries/${discarded.entryId}`)).body.entry;
    expect(entry).toMatchObject({ action: 'discard', outcome: 'done', operatorName: 'operator@example.com' });
    expect(Buffer.from(entry.message.body, 'base64').toString()).toBe(discarded.payload);

    // The process died, so its connection dropped: the lock is gone and the Message is back.
    const again = await eventually(async () => {
      const res = await survivor.browser.post(checkoutPath);
      expect(res.status).toBe(201);
      expect(res.body.checkout.messages.map((m: any) => m.messageId)).toContain(liveCheckout.messageId);
      return res.body.checkout;
    }, 60_000);
    await survivor.browser.post(`/api/checkouts/${again.id}/end`);
  });

  it('keep sessions through a rolling helm upgrade with one pod always serving, and a Checkout on a replaced pod says why it ended', async () => {
    const before = await servePods(2);
    const { checkout } = await startCheckoutWithNewMessage(before[0]!.browser, 'rolling');
    const uids = before.map((p) => p.uid);

    let finished = false;
    const upgrade = helmAsync(helmInstallArgs([replicasValues, `${smokeDir}/values-upgrade.yaml`])).finally(() => (finished = true));
    let fewestReady = Number.POSITIVE_INFINITY;
    while (!finished) {
      fewestReady = Math.min(fewestReady, volveranPods().filter((p) => p.ready).length);
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    await upgrade;
    expect(fewestReady).toBeGreaterThanOrEqual(1);

    const after = await servePods(2);
    expect(after.filter((p) => uids.includes(p.uid))).toEqual([]);
    for (const { browser } of after) {
      const session = await browser.get('/api/session');
      expect(session.status).toBe(200);
      expect(session.body.operatorId).toBe('smoke-operator');
    }
    const { profiles } = (await after[0]!.browser.get('/api/profiles')).body;
    expect(profiles.map((p: any) => [p.name, p.defaultQueueFilter])).toEqual([['smoke', 'orders.*']]);

    const view = await viewOf(after[1]!.browser, checkout.id);
    expect([view.status, view.endReason]).toEqual(['ended', 'shutdown']);
  });
});

describe('three Replicas on kind', () => {
  it('have one Background Leader, serve a Checkout through each, and report it lost through both others when its owner dies', async () => {
    await helmAsync([...helmInstallArgs([replicasValues, `${smokeDir}/values-upgrade.yaml`]), '--set', 'replicaCount=3']);
    const [owner, second, third] = await servePods(3);

    await eventually(() => {
      const leaders = [owner!, second!, third!].map((pod) => {
        const code = `fetch('http://127.0.0.1:9464/metrics').then((r) => r.text()).then((t) => console.log(/^volveran_background_leader 1$/m.test(t)))`;
        return kubectl(['-n', appNamespace, 'exec', pod.name, '-c', 'volveran', '--', 'node', '-e', code]).trim();
      });
      expect(leaders.filter((l) => l === 'true')).toHaveLength(1);
    }, 60_000);

    const { checkout, handle } = await startCheckoutWithNewMessage(owner!.browser, 'three');
    const decided = await second!.browser.post(`/api/checkouts/${checkout.id}/decisions`, { handles: [handle], decision: { kind: 'keep' } });
    expect(decided.status).toBe(200);
    expect((await viewOf(third!.browser, checkout.id)).status).toBe('active');

    crash(owner!);
    expect((await lostThrough(second!.browser, checkout.id)).lostReason).toMatch(/Replica/);
    expect((await lostThrough(third!.browser, checkout.id)).lostReason).toMatch(/Replica/);
  });
});
