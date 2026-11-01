// The rest of a Checkout through the Replica that does not own it: Decisions, reading
// Messages, Apply, stop, Canary continue, export and ending it. Every request here goes to
// the non-owner, unless a test says otherwise, and asserts what the Operator sees.
import { setTimeout as sleep } from 'node:timers/promises';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { appliedCheckout, deadLetter, deadLetterRoutes, eventually, fixtureQueues, purgeQueues, readyCount, readyMessageIds, seedMessages, testProfile, withChannel } from './harness.js';
import { startTwoReplicas, type Replica, type ReplicaBrowser, type TwoReplicas } from './two-replicas.js';

const QUEUE = 'forwarding-rest.dlq';
const MOVED_TO = 'forwarding-rest.moved';
const startPath = `/api/profiles/dev/vhosts/%2F/queues/${QUEUE}/checkouts`;
const ana = { sub: 'ana-sub', email: 'ana@example.com', groups: ['ops'] };
const ben = { sub: 'ben-sub', email: 'ben@example.com', groups: ['ops'] };
const DISCARD = { kind: 'discard', reason: 'bad payload' };
const profile = () => testProfile({ name: 'dev', roles: { operator: ['ops'] } });

async function resetQueues(): Promise<void> {
  await withChannel('/', async (ch) => {
    await ch.assertQueue(QUEUE, { durable: true });
    await ch.assertQueue(MOVED_TO, { durable: true });
  });
  await purgeQueues('/', [QUEUE, MOVED_TO]);
}

/** A gate a test opens later: `wait` resolves once `open` is called. */
function gate() {
  let open!: () => void;
  const wait = new Promise<void>((resolve) => (open = resolve));
  return { wait, open };
}

/** The raw answer to an export through `to`, with the Operator's cookies, so a test can read it as a stream. */
function postExport(browser: ReplicaBrowser, to: Replica, id: string, signal?: AbortSignal): Promise<Response> {
  return fetch(`${to.baseUrl}/api/checkouts/${id}/export`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: [...browser.cookies].map(([k, v]) => `${k}=${v}`).join('; ') },
    body: '{}',
    ...(signal && { signal }),
  });
}

describe('working on a Checkout through the Replica that does not own it', () => {
  let replicas: TwoReplicas;
  let browser: ReplicaBrowser;
  let owner: Replica;
  let other: ReplicaBrowser;
  let checkout: { id: string; handles: number[] };
  const path = (rest = '') => `/api/checkouts/${checkout.id}${rest}`;

  beforeAll(async () => {
    await resetQueues();
    replicas = await startTwoReplicas({ profiles: [profile()] });
    browser = replicas.browser();
    await browser.signIn(ana);
    owner = replicas.a;
    other = browser.to(replicas.b);
  });
  afterAll(async () => {
    await replicas?.close();
  });
  beforeEach(async () => {
    await seedMessages('/', QUEUE, 3);
    const started = await browser.to(owner).post(startPath, {});
    expect(started.status).toBe(201);
    checkout = { id: started.body.checkout.id, handles: started.body.checkout.messages.map((m: { handle: number }) => m.handle) };
  });
  afterEach(async () => {
    await browser.to(owner).post(path('/end'));
    await purgeQueues('/', [QUEUE, MOVED_TO]);
  });

  it('gives a Decision, and the owner shows it', async () => {
    const decided = await other.post(path('/decisions'), { handles: checkout.handles.slice(0, 2), decision: DISCARD });
    expect(decided.status).toBe(200);
    expect(decided.body.rejected).toEqual([]);
    const seen = (await browser.to(owner).get(path())).body.checkout;
    expect(seen.messages.map((m: { decision: { kind: string } }) => m.decision.kind)).toEqual(['discard', 'discard', 'keep']);
  });

  it('checks a Move destination against the broker', async () => {
    const decided = await other.post(path('/decisions'), { handles: [checkout.handles[0]], decision: { kind: 'move', destination: { queue: MOVED_TO } } });
    expect(decided.status).toBe(200);
    const refused = await other.post(path('/decisions'), { handles: [checkout.handles[0]], decision: { kind: 'move', destination: { queue: 'no-such-queue' } } });
    expect(refused.body.error.code).toBe('decision_not_allowed');
  });

  it('answers a bad request as the owner does', async () => {
    const fromOther = await other.post(path('/decisions'), { handles: 'all', decision: DISCARD });
    const fromOwner = await browser.to(owner).post(path('/decisions'), { handles: 'all', decision: DISCARD });
    expect(fromOther.status).toBe(400);
    expect(fromOther.body).toEqual(fromOwner.body);
  });

  it('selects all matching', async () => {
    const matching = await other.post(path('/matching'), { filter: [] });
    expect(matching.status).toBe(200);
    expect(matching.body.count).toBe(3);
    expect(matching.body.handles).toEqual(checkout.handles);
  });

  it('reads a Message and compares two', async () => {
    const [a, b] = checkout.handles;
    const message = await other.get(path(`/messages/${a}`));
    expect(message.status).toBe(200);
    expect(message.body.message.handle).toBe(a);
    const compared = await other.get(path(`/compare?a=${a}&b=${b}`));
    expect(compared.status).toBe(200);
    expect(compared.body.left.handle).toBe(a);
    expect(compared.body.right.handle).toBe(b);
  });

  it('puts the Messages back when it is ended, by either way of ending it', async () => {
    const ended = await other.request('DELETE', path());
    expect(ended.status).toBe(200);
    expect(ended.body.checkout.endReason).toBe('operator');
    expect(await readyMessageIds('/', QUEUE)).toHaveLength(3);

    const again = await browser.to(owner).post(startPath, {});
    expect(again.status).toBe(201);
    const beacon = await other.post(`/api/checkouts/${again.body.checkout.id}/end`);
    expect(beacon.status).toBe(200);
    expect(beacon.body.checkout.status).toBe('ended');
  });

  it.each([
    ['POST', '/matching'],
    ['POST', '/decisions'],
    ['GET', '/messages/1'],
    ['GET', '/compare?a=1&b=2'],
    ['POST', '/apply'],
    ['POST', '/apply/stop'],
    ['POST', '/apply/continue'],
    ['POST', '/export'],
    ['POST', '/end'],
    ['DELETE', ''],
  ])("refuses another Operator's %s %s as the owner does", async (method, rest) => {
    const someone = replicas.browser();
    await someone.signIn(ben);
    const refused = await someone.to(replicas.b).request(method, path(rest), method === 'POST' ? { body: {} } : {});
    expect(refused.status).toBe(403);
    expect(refused.body.error.code).toBe('not_checkout_owner');
  });
});

describe('an Apply through the Replica that does not own the Checkout', () => {
  const route = deadLetterRoutes.classic;
  const canaryPath = `/api/profiles/canary/vhosts/%2F/queues/${encodeURIComponent(route.dlq)}/checkouts`;
  let replicas: TwoReplicas;
  let browser: ReplicaBrowser;
  let owner: Replica;
  let other: ReplicaBrowser;
  let beforeApplyStep: (() => Promise<void>) | null = null;
  const open: string[] = [];

  /** Holds the Apply's first step until `release`; `held` resolves once it is held. */
  function holdFirstStep() {
    const held = gate();
    const release = gate();
    let steps = 0;
    beforeApplyStep = async () => {
      if (++steps !== 1) return;
      held.open();
      await release.wait;
    };
    return { held: held.wait, release: release.open };
  }

  async function checkoutWithDiscards(): Promise<string> {
    await seedMessages('/', QUEUE, 3);
    const started = await browser.to(owner).post(startPath, {});
    expect(started.status).toBe(201);
    const { id, messages } = started.body.checkout;
    open.push(id);
    const decided = await other.post(`/api/checkouts/${id}/decisions`, { handles: messages.map((m: { handle: number }) => m.handle), decision: DISCARD });
    expect(decided.status).toBe(200);
    return id;
  }

  const statuses = (checkout: { lastApply: { outcomes: Array<{ status: string }> } }) => checkout.lastApply.outcomes.map((o) => o.status);

  beforeAll(async () => {
    await resetQueues();
    await purgeQueues('/', fixtureQueues);
    replicas = await startTwoReplicas({
      profiles: [profile(), testProfile({ name: 'canary', roles: { operator: ['ops'] }, canary: { watchWindow: '60s' } })],
      perReplica: () => ({ checkoutTestHooks: { beforeApplyStep: async () => beforeApplyStep?.() } }),
    });
    browser = replicas.browser();
    await browser.signIn(ana);
    owner = replicas.a;
    other = browser.to(replicas.b);
  });
  afterAll(async () => {
    await replicas?.close();
    await purgeQueues('/', fixtureQueues);
  });
  afterEach(async () => {
    beforeApplyStep = null;
    for (const id of open.splice(0)) await browser.to(owner).post(`/api/checkouts/${id}/end`);
    await purgeQueues('/', [QUEUE, ...fixtureQueues]);
  });

  it('starts it, and its progress and outcome can be followed through either Replica', async () => {
    const id = await checkoutWithDiscards();
    const { held, release } = holdFirstStep();
    const started = await other.post(`/api/checkouts/${id}/apply`, { confirm: true });
    expect(started.status).toBe(202);
    expect(started.body.checkout.status).toBe('applying');
    await held;

    for (const replica of [replicas.a, replicas.b]) {
      const { checkout } = (await browser.to(replica).get(`/api/checkouts/${id}`)).body;
      expect(checkout.status).toBe('applying');
      expect(checkout.applyProgress).toMatchObject({ total: 3, phase: 'running', done: 0 });
    }

    release();
    const fromOther = await appliedCheckout(other, id);
    expect(statuses(fromOther)).toEqual(['done', 'done', 'done']);
    expect(statuses(await appliedCheckout(browser.to(owner), id))).toEqual(['done', 'done', 'done']);
    expect(await readyCount('/', QUEUE)).toBe(0);
    const { entries } = (await other.get(`/api/audit-entries?checkoutId=${id}&action=discard`)).body;
    expect(entries.map((e: { operatorId: string; outcome: string }) => [e.operatorId, e.outcome])).toEqual(Array(3).fill([ana.sub, 'done']));
  });

  it('stops it, and names who did', async () => {
    const id = await checkoutWithDiscards();
    const { held, release } = holdFirstStep();
    expect((await browser.to(owner).post(`/api/checkouts/${id}/apply`, { confirm: true })).status).toBe(202);
    await held;

    const stopped = await other.post(`/api/checkouts/${id}/apply/stop`);
    expect(stopped.status).toBe(200);
    expect(stopped.body.checkout.applyProgress.stoppedBy).toBeTruthy();

    release();
    expect(statuses(await appliedCheckout(other, id))).toEqual(['done', 'not-attempted', 'not-attempted']);
    expect(await readyCount('/', QUEUE)).toBe(2);
  });

  it('answers that there is nothing to stop as the owner does', async () => {
    const id = await checkoutWithDiscards();
    const stopped = await other.post(`/api/checkouts/${id}/apply/stop`);
    expect(stopped.status).toBe(409);
    expect(stopped.body.error.code).toBe('apply_not_running');
  });

  it('continues it after its Canary', async () => {
    await deadLetter(route, ['canary-0', 'canary-1'].map((messageId) => ({ body: messageId, options: { messageId } })));
    await purgeQueues('/', route.dlqs.filter((q) => q !== route.dlq));
    const started = await browser.to(owner).post(canaryPath, {});
    expect(started.status).toBe(201);
    const { id, messages } = started.body.checkout;
    open.push(id);
    await other.post(`/api/checkouts/${id}/decisions`, { handles: messages.map((m: { handle: number }) => m.handle), decision: { kind: 'replay' } });
    expect((await other.post(`/api/checkouts/${id}/apply`, { confirm: true, canary: true })).status).toBe(202);
    const watching = await eventually(async () => {
      const { checkout } = (await other.get(`/api/checkouts/${id}`)).body;
      expect(checkout.applyProgress?.phase).toBe('canary_watch');
      return checkout;
    });
    expect(watching.canary.messageId).toBe('canary-0');

    const continued = await other.post(`/api/checkouts/${id}/apply/continue`);
    expect(continued.status).toBe(200);
    expect(statuses(await appliedCheckout(other, id))).toEqual(['done', 'done']);
    expect(await readyMessageIds('/', route.workQueue)).toEqual(['canary-0', 'canary-1']);
  });

  it('waits past the usual limit for an end that waits for the Apply, rather than call the owner unreachable', async () => {
    const id = await checkoutWithDiscards();
    const { held, release } = holdFirstStep();
    expect((await browser.to(owner).post(`/api/checkouts/${id}/apply`, { confirm: true })).status).toBe(202);
    await held;

    const ending = other.request('DELETE', `/api/checkouts/${id}`);
    await sleep(11_000);
    release();
    const ended = await ending;
    expect(ended.status).toBe(200);
    expect(ended.body.checkout.status).toBe('ended');
  });
});

describe('an export through the Replica that does not own the Checkout', () => {
  let replicas: TwoReplicas;
  let browser: ReplicaBrowser;
  let beforeExportLine: ((position: number) => Promise<void>) | null = null;
  const LIVE = 3;

  const startOnA = async (on: TwoReplicas = replicas, as: ReplicaBrowser = browser): Promise<string> => {
    await seedMessages('/', QUEUE, LIVE);
    const started = await as.to(on.a).post(startPath, {});
    expect(started.status).toBe(201);
    return started.body.checkout.id;
  };
  const exportEntry = async (id: string) => (await browser.to(replicas.b).get(`/api/audit-entries?action=export&checkoutId=${id}`)).body.entries[0];
  /** Holds the export before it makes the line at `at`. */
  const holdLine = (at: number) => {
    const line = gate();
    beforeExportLine = async (position) => {
      if (position === at) await line.wait;
    };
    return line;
  };

  beforeAll(async () => {
    await resetQueues();
    replicas = await startTwoReplicas({
      profiles: [profile()],
      perReplica: () => ({ checkoutTestHooks: { beforeExportLine: async (position) => beforeExportLine?.(position) } }),
    });
    browser = replicas.browser();
    await browser.signIn(ana);
  });
  afterAll(async () => {
    await replicas?.close();
  });
  afterEach(async () => {
    beforeExportLine = null;
    await purgeQueues('/', [QUEUE]);
  });

  it('downloads the same file, with its headers, and records it', async () => {
    const id = await startOnA();
    const res = await postExport(browser, replicas.b, id);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('application/x-ndjson');
    expect(res.headers.get('content-disposition')).toMatch(/^attachment; filename="volveran-dev-.*\.ndjson"$/);
    expect(res.headers.get('x-volveran-message-count')).toBe(String(LIVE));
    const lines = (await res.text()).trimEnd().split('\n').map((line) => JSON.parse(line) as { position: number });
    expect(lines.map((line) => line.position)).toEqual([1, 2, 3]);
    await eventually(async () => expect(await exportEntry(id)).toMatchObject({ outcome: 'done', messageCount: LIVE }));
    await browser.to(replicas.a).post(`/api/checkouts/${id}/end`);
  });

  it('passes on each line as it is made, before the owner has made the rest', async () => {
    const id = await startOnA();
    const lastLine = holdLine(LIVE);
    const res = await postExport(browser, replicas.b, id);
    const reader = res.body!.getReader();
    let text = '';
    while (text.split('\n').length <= LIVE - 1) text += Buffer.from((await reader.read()).value!).toString();
    expect(text.trimEnd().split('\n')).toHaveLength(LIVE - 1);
    lastLine.open();
    for (let next = await reader.read(); !next.done; next = await reader.read()) text += Buffer.from(next.value).toString();
    expect(text.trimEnd().split('\n')).toHaveLength(LIVE);
    await browser.to(replicas.a).post(`/api/checkouts/${id}/end`);
  });

  it('records a download the Operator walked away from as failed', async () => {
    const id = await startOnA();
    // The second line, so the third is never made: a generator held on its last line finishes it, and counts as done.
    const secondLine = holdLine(2);
    const walkAway = new AbortController();
    const res = await postExport(browser, replicas.b, id, walkAway.signal);
    await res.body!.getReader().read();
    walkAway.abort();
    await sleep(200);
    secondLine.open();
    await eventually(async () => expect((await exportEntry(id)).outcome).toBe('failed'));
    await browser.to(replicas.a).post(`/api/checkouts/${id}/end`);
  });

  it('fails the download when the owner dies part way, rather than end it as if complete', async () => {
    const dying = await startTwoReplicas({
      profiles: [profile()],
      perReplica: () => ({ checkoutTestHooks: { beforeExportLine: async (position) => beforeExportLine?.(position) } }),
    });
    const lastLine = holdLine(LIVE);
    try {
      const own = dying.browser();
      await own.signIn(ana);
      const id = await startOnA(dying, own);
      const res = await postExport(own, dying.b, id);
      const reader = res.body!.getReader();
      await reader.read();
      await dying.a.crash();
      await expect(
        (async () => {
          for (let next = await reader.read(); !next.done; next = await reader.read());
        })(),
      ).rejects.toThrow();
    } finally {
      lastLine.open();
      await dying.close();
    }
  });
});

describe('a Checkout whose Owner Replica has died', () => {
  it('answers every route on the other Replica as a Lost Checkout, not as one that never existed', async () => {
    await resetQueues();
    const replicas = await startTwoReplicas({ profiles: [profile()], replicaLeaseTiming: { renewEveryMs: 100, holdsForMs: 400 } });
    try {
      const browser = replicas.browser();
      await browser.signIn(ana);
      await seedMessages('/', QUEUE, 1);
      const started = await browser.to(replicas.a).post(startPath, {});
      expect(started.status).toBe(201);
      const { id, messages } = started.body.checkout;
      await replicas.a.crash();
      const other = browser.to(replicas.b);
      await eventually(async () => expect((await other.post(`/api/checkouts/${id}/matching`, { filter: [] })).status).toBe(200));

      expect((await other.post(`/api/checkouts/${id}/decisions`, { handles: messages.map((m: { handle: number }) => m.handle), decision: DISCARD })).body.rejected).toHaveLength(1);
      for (const rest of ['/apply', '/export']) {
        const refused = await other.post(`/api/checkouts/${id}${rest}`, { confirm: true });
        expect(refused.status).toBe(409);
        expect(refused.body.error.code).toBe('checkout_not_active');
      }
      const ended = await other.post(`/api/checkouts/${id}/end`);
      expect(ended.status).toBe(200);
      expect(ended.body.checkout.status).toBe('lost');
    } finally {
      await replicas.close();
      await purgeQueues('/', [QUEUE]);
    }
  });
});

describe('a large export through the Replica that does not own the Checkout', () => {
  const COUNT = 90;
  const SIZE = 1024 * 1024;
  let replicas: TwoReplicas;
  let browser: ReplicaBrowser;
  let made = 0;
  let id: string | undefined;

  beforeAll(async () => {
    await resetQueues();
    replicas = await startTwoReplicas({
      profiles: [profile()],
      checkoutLimits: { maxBytes: 100 * SIZE },
      perReplica: () => ({
        checkoutTestHooks: {
          beforeExportLine: async () => {
            made++;
          },
        },
      }),
    });
    browser = replicas.browser();
    await browser.signIn(ana);
  }, 60_000);
  afterAll(async () => {
    if (id) await browser.to(replicas.a).post(`/api/checkouts/${id}/end`);
    await purgeQueues('/', [QUEUE, MOVED_TO]);
    await replicas?.close();
    await withChannel('/', async (ch) => {
      await ch.deleteQueue(QUEUE);
      await ch.deleteQueue(MOVED_TO);
    });
  }, 120_000);

  it('makes lines only as the Operator reads them, and arrives whole', async () => {
    await withChannel('/', async (ch) => {
      for (let i = 0; i < COUNT; i++) ch.sendToQueue(QUEUE, Buffer.alloc(SIZE, i), { messageId: `m${i}` });
      await ch.waitForConfirms();
    });
    const started = await browser.to(replicas.a).post(startPath, {});
    expect(started.status).toBe(201);
    id = started.body.checkout.id;
    expect(started.body.checkout.heldCount).toBe(COUNT);

    const res = await postExport(browser, replicas.b, id!);
    expect(res.status).toBe(200);
    const reader = res.body!.getReader();
    let chunk = await reader.read();
    // The reader stalls: back through the forwarding Replica, the owner stops making lines.
    await sleep(1_000);
    expect(made).toBeLessThan(COUNT / 2);

    let partial = Buffer.alloc(0);
    const positions: number[] = [];
    let mismatched = 0;
    while (!chunk.done) {
      let rest = Buffer.concat([partial, Buffer.from(chunk.value)]);
      for (let nl = rest.indexOf(0x0a); nl !== -1; nl = rest.indexOf(0x0a)) {
        const line = JSON.parse(rest.subarray(0, nl).toString()) as { position: number; body: string };
        if (!Buffer.from(line.body, 'base64').equals(Buffer.alloc(SIZE, line.position - 1))) mismatched++;
        positions.push(line.position);
        rest = rest.subarray(nl + 1);
      }
      partial = rest;
      chunk = await reader.read();
    }
    expect(partial.length).toBe(0);
    expect(mismatched).toBe(0);
    expect(positions).toEqual(Array.from({ length: COUNT }, (_, i) => i + 1));
    expect(made).toBe(COUNT);
  }, 300_000);
});
