// A Replica shutting down (#119), as on SIGTERM: it says it is not ready, takes no new
// Checkout, stops an Apply at a step boundary, gives its Messages back through Keep, gives up
// the leader lease, and its Operators can still find out why, through any Replica.
import { readFile } from 'node:fs/promises';
import { afterEach, describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import type { LeaderControl } from '../../src/server/leader/background-leader.js';
import { startTcpProxy } from '../support/tcp-proxy.js';
import { drain, eventually, purgeQueues, readyCount, seedMessages, startApp, testBroker, testProfile, withChannel } from './harness.js';
import { startTwoReplicas, type ReplicaBrowser, type ReplicaName, type TwoReplicas, type TwoReplicasOptions } from './two-replicas.js';

const CLASSIC = 'orders.dlq';
const QUORUM = 'payments.dlq';
const startPath = (queue: string, profile = 'dev') => `/api/profiles/${profile}/vhosts/%2F/queues/${encodeURIComponent(queue)}/checkouts`;
const ana = { sub: 'ana-sub', email: 'ana@example.com', groups: ['ops'] };
const DISCARD = { kind: 'discard', reason: 'bad payload' };
const profile = () => testProfile({ name: 'dev', roles: { operator: ['ops'] } });

/** A gate a test opens later: `wait` resolves once `open` is called. */
function gate() {
  let open!: () => void;
  const wait = new Promise<void>((resolve) => (open = resolve));
  return { wait, open };
}

/** Takes every ready Message of the queue for good: how many, and how many have a delivery counted. */
async function takeAll(queue: string): Promise<{ taken: number; counted: number }> {
  return withChannel('/', async (ch) => {
    const taken = await drain(ch, queue);
    return { taken: taken.length, counted: taken.filter((m) => m.properties.headers?.['x-delivery-count'] !== undefined).length };
  });
}

/** Whether `work` settled within `ms`, so that a hang fails a test by what it is. */
async function settledWithin(work: Promise<unknown>, ms: number): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<boolean>((resolve) => (timer = setTimeout(() => resolve(false), ms)));
  try {
    return await Promise.race([work.then(() => true), late]);
  } finally {
    clearTimeout(timer);
  }
}

/** A request with the Operator's cookies to an address, for a Replica the harness already counts as stopped; a body makes it a POST. */
function asOperator(browser: ReplicaBrowser, url: string, path: string, body?: unknown): Promise<Response> {
  return fetch(url + path, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'content-type': 'application/json', cookie: [...browser.cookies].map(([k, v]) => `${k}=${v}`).join('; ') },
    ...(body !== undefined && { body: JSON.stringify(body) }),
  });
}

describe('a Replica shutting down', () => {
  let replicas: TwoReplicas | undefined;
  /** What a test has held open, for when it fails holding it. */
  const toOpen: Array<() => void> = [];

  const start = async (options: TwoReplicasOptions = {}) => {
    replicas = await startTwoReplicas({ profiles: [profile()], ...options });
    const browser = replicas.browser();
    await browser.signIn(ana);
    return { replicas, browser };
  };

  /** Two Replicas whose Apply steps on `a` wait at a gate, and a Checkout there with `count` Discards, whose Apply has reached its first step. */
  const applyingOnA = async (queue: string, count: number) => {
    const step = gate();
    const reached = gate();
    toOpen.push(step.open);
    const { replicas, browser } = await start({
      perReplica: (name) =>
        name === 'a'
          ? {
              checkoutTestHooks: {
                beforeApplyStep: async () => {
                  reached.open();
                  await step.wait;
                },
              },
            }
          : {},
    });
    await seedMessages('/', queue, count);
    const { id, messages } = (await browser.to(replicas.a).post(startPath(queue), {})).body.checkout as { id: string; messages: Array<{ handle: number }> };
    await browser.to(replicas.a).post(`/api/checkouts/${id}/decisions`, { handles: messages.map((m) => m.handle), decision: DISCARD });
    expect((await browser.to(replicas.a).post(`/api/checkouts/${id}/apply`, { confirm: true })).status).toBe(202);
    await reached.wait;
    return { replicas, browser, id, step };
  };

  afterEach(async () => {
    for (const open of toOpen.splice(0)) open();
    await replicas?.close();
    replicas = undefined;
    await purgeQueues('/', [CLASSIC, QUORUM]);
  });

  it('returns held Messages on a quorum queue without using Delivery Budget', async () => {
    const { replicas, browser } = await start();
    await seedMessages('/', QUORUM, 200);
    const started = await browser.to(replicas.a).post(startPath(QUORUM), {});
    expect(started.body.checkout.heldCount).toBe(200);

    await replicas.a.shutdown();

    expect(await takeAll(QUORUM)).toEqual({ taken: 200, counted: 0 });
  }, 90_000);

  it('tells the Operator why through the other Replica, and lets them start another there', async () => {
    const { replicas, browser } = await start();
    await seedMessages('/', CLASSIC, 2);
    const { id } = (await browser.to(replicas.a).post(startPath(CLASSIC), {})).body.checkout as { id: string };

    await replicas.a.shutdown();

    const view = await browser.to(replicas.b).get(`/api/checkouts/${id}`);
    expect(view.status).toBe(200);
    expect(view.body.checkout).toMatchObject({ status: 'ended', endReason: 'shutdown', lostReason: null, ownerGone: false });
    const beat = await browser.to(replicas.b).post(`/api/checkouts/${id}/heartbeat`);
    expect([beat.status, beat.body.checkout.endReason]).toEqual([200, 'shutdown']);
    expect((await browser.to(replicas.b).get('/api/session')).body.checkoutId).toBeNull();
    const again = await browser.to(replicas.b).post(startPath(CLASSIC), {});
    expect(again.status, JSON.stringify(again.body)).toBe(201);
    expect(again.body.checkout.heldCount).toBe(2);
    await browser.to(replicas.b).post(`/api/checkouts/${again.body.checkout.id}/end`);
  });

  it('still says so through the Replica that comes back in its place', async () => {
    const { replicas, browser } = await start();
    await seedMessages('/', CLASSIC, 1);
    const { id } = (await browser.to(replicas.a).post(startPath(CLASSIC), {})).body.checkout as { id: string };

    await replicas.a.shutdown();
    await replicas.a.restart();

    const view = await browser.to(replicas.a).get(`/api/checkouts/${id}`);
    expect([view.status, view.body.checkout?.endReason]).toEqual([200, 'shutdown']);
  });

  it('clears the record up once it has been readable for as long as a Checkout that is over', async () => {
    const { replicas, browser } = await start({ endedCheckoutRetentionMs: 200, replicaLeaseTiming: { renewEveryMs: 100, holdsForMs: 2_000 } });
    await seedMessages('/', CLASSIC, 1);
    await browser.to(replicas.a).post(startPath(CLASSIC), {});

    await replicas.a.shutdown();

    await eventually(async () => {
      expect((await replicas.database.query('SELECT 1 FROM live_checkouts')).rows).toHaveLength(0);
      expect((await replicas.database.query('SELECT 1 FROM replicas')).rows).toHaveLength(1);
    }, 10_000);
  });

  it('is not ready and refuses new Checkouts from the start, but stays alive and keeps answering for what it holds, through either Replica', async () => {
    const { replicas, browser, id, step } = await applyingOnA(CLASSIC, 2);
    await seedMessages('/', QUORUM, 1);
    // Once `shutdown` is called the harness counts it as stopped; the port stays up until it is.
    const url = replicas.a.baseUrl;
    expect((await fetch(`${url}/readyz`)).status).toBe(200);

    const stopping = replicas.a.shutdown();

    await eventually(async () => expect((await fetch(`${url}/readyz`)).status).toBe(503));
    expect(await (await fetch(`${url}/readyz`)).json()).toEqual({ status: 'unavailable' });
    expect((await fetch(`${url}/healthz`)).status).toBe(200);
    const refused = await asOperator(browser, url, startPath(QUORUM), {});
    expect(refused.status).toBe(503);
    expect((await refused.json()).error).toMatchObject({ code: 'replica_shutting_down', tryAgain: true });
    expect((await asOperator(browser, url, `/api/checkouts/${id}`)).status).toBe(200);
    expect((await browser.to(replicas.b).get(`/api/checkouts/${id}`)).status).toBe(200);

    step.open();
    await stopping;
  });

  it('stops a running Apply at a step boundary: the step in progress finishes, the rest goes back through Keep, and the outcome is known', async () => {
    const { replicas, browser, id, step } = await applyingOnA(QUORUM, 3);
    const url = replicas.a.baseUrl;

    const stopping = replicas.a.shutdown();
    await eventually(async () => expect((await fetch(`${url}/readyz`)).status).toBe(503));
    step.open();
    // Its last answers, before it goes.
    const ended = await eventually(async () => {
      const view = await (await asOperator(browser, url, `/api/checkouts/${id}`)).json();
      expect(view.checkout?.lastApply).toBeTruthy();
      return view.checkout;
    });
    await stopping;

    expect(ended.endReason).toBe('shutdown');
    const outcomes = ended.lastApply.outcomes as Array<{ status: string; reason: string | null }>;
    expect(outcomes.map((o) => o.status)).toEqual(['done', 'not-attempted', 'not-attempted']);
    expect(outcomes[1]!.reason).toMatch(/Replica shut down.*back in the queue/);
    expect(await takeAll(QUORUM)).toEqual({ taken: 2, counted: 0 });
    const after = await browser.to(replicas.b).get(`/api/checkouts/${id}`);
    expect([after.body.checkout.status, after.body.checkout.endReason]).toEqual(['ended', 'shutdown']);
  }, 60_000);

  it('ends an Apply waiting at its next paced step at once, with nothing more done', async () => {
    const moved = 'graceful-shutdown.moved';
    const { replicas, browser } = await start();
    await seedMessages('/', CLASSIC, 3);
    await withChannel('/', (ch) => ch.assertQueue(moved, { durable: true }));
    const { id, messages } = (await browser.to(replicas.a).post(startPath(CLASSIC), {})).body.checkout as { id: string; messages: Array<{ handle: number }> };
    await browser.to(replicas.a).post(`/api/checkouts/${id}/decisions`, {
      handles: messages.map((m) => m.handle),
      decision: { kind: 'move', destination: { queue: moved } },
    });
    // One Message every 10 s: nothing but the stop ends this soon.
    expect((await browser.to(replicas.a).post(`/api/checkouts/${id}/apply`, { confirm: true, rate: 0.1 })).status).toBe(202);

    expect(await settledWithin(replicas.a.shutdown(), 5_000)).toBe(true);

    expect(await readyCount('/', CLASSIC)).toBeGreaterThanOrEqual(1);
    await withChannel('/', (ch) => ch.deleteQueue(moved));
  });

  it('moves the leader lease before its Messages are back, not when it would run out', async () => {
    const controls: Partial<Record<ReplicaName, LeaderControl>> = {};
    const step = gate();
    const reached = gate();
    toOpen.push(step.open);
    const { replicas, browser } = await start({
      perReplica: (name) => ({
        leaderTestHooks: { timing: { leaseMs: 600_000, renewMs: 100 }, leader: (control) => (controls[name] = control) },
        ...(name === 'a' && {
          checkoutTestHooks: {
            beforeApplyStep: async () => {
              reached.open();
              await step.wait;
            },
          },
        }),
      }),
    });
    expect(controls.a!.isLeader).toBe(true);
    await seedMessages('/', CLASSIC, 1);
    const { id, messages } = (await browser.to(replicas.a).post(startPath(CLASSIC), {})).body.checkout as { id: string; messages: Array<{ handle: number }> };
    await browser.to(replicas.a).post(`/api/checkouts/${id}/decisions`, { handles: [messages[0]!.handle], decision: DISCARD });
    await browser.to(replicas.a).post(`/api/checkouts/${id}/apply`, { confirm: true });
    await reached.wait;

    const stopping = replicas.a.shutdown();

    // The Apply still holds its step, so the Checkout has not ended.
    await eventually(async () => expect(controls.b!.isLeader).toBe(true), 5_000);
    step.open();
    await stopping;
  });

  it('does not wait long for a client still reading once its Checkouts are over', async () => {
    const line = gate();
    const reached = gate();
    toOpen.push(line.open);
    const { replicas, browser } = await start({
      perReplica: (name) =>
        name === 'a'
          ? {
              checkoutTestHooks: {
                beforeExportLine: async (position) => {
                  if (position < 2) return;
                  reached.open();
                  await line.wait;
                },
              },
            }
          : {},
    });
    await seedMessages('/', CLASSIC, 3);
    const { id } = (await browser.to(replicas.a).post(startPath(CLASSIC), {})).body.checkout as { id: string };
    const exporting = asOperator(browser, replicas.a.baseUrl, `/api/checkouts/${id}/export`, {});
    exporting.catch(() => {});
    await reached.wait;

    expect(await settledWithin(replicas.a.shutdown(), 15_000)).toBe(true);
  }, 30_000);
});

describe('one Replica shutting down', () => {
  afterEach(() => purgeQueues('/', [CLASSIC, QUORUM]));

  it('refuses a start that was on its way when shutdown began, and returns what it took', async () => {
    const locked = gate();
    const release = gate();
    const app = await startApp({
      profiles: [testProfile({ name: 'local' })],
      checkoutTestHooks: {
        afterLock: async () => {
          locked.open();
          await release.wait;
        },
      },
    });
    await seedMessages('/', QUORUM, 3);
    const starting = app.post(startPath(QUORUM, 'local'));
    await locked.wait;

    const stopping = app.close();
    await eventually(async () => expect((await app.get('/readyz')).status).toBe(503));
    release.open();

    const answer = await starting;
    await stopping;
    expect([answer.status, answer.body.error?.code]).toEqual([503, 'replica_shutting_down']);
    expect(await takeAll(QUORUM)).toEqual({ taken: 3, counted: 0 });
  }, 30_000);

  it("at the default limits, with an Apply running on 1,000 Messages, is done well inside the chart's grace period, and uses no Delivery Budget", async () => {
    const step = gate();
    const reached = gate();
    const app = await startApp({
      profiles: [testProfile({ name: 'local' })],
      checkoutTestHooks: {
        beforeApplyStep: async () => {
          reached.open();
          await step.wait;
        },
      },
    });
    await seedMessages('/', QUORUM, 1_000);
    const { checkout } = (await app.post(startPath(QUORUM, 'local'))).body;
    expect(checkout.heldCount).toBe(1_000);
    await app.post(`/api/checkouts/${checkout.id}/decisions`, { handles: 'all', decision: DISCARD });
    expect((await app.post(`/api/checkouts/${checkout.id}/apply`, { confirm: true })).status).toBe(202);
    await reached.wait;

    const began = Date.now();
    const stopping = app.close();
    step.open();
    await stopping;
    const tookMs = Date.now() - began;

    const values = parse(await readFile('charts/volveran/values.yaml', 'utf8')) as { pod: { terminationGracePeriodSeconds: number } };
    expect(tookMs).toBeLessThan(values.pod.terminationGracePeriodSeconds * 1000);
    expect(await takeAll(QUORUM)).toEqual({ taken: 999, counted: 0 });
  }, 180_000);

  describe('when its broker connection has gone', () => {
    it.each([CLASSIC, QUORUM])('closes at once with a live Checkout of %s, just after the connection drops', async (queue) => {
      const proxy = await startTcpProxy(testBroker.amqpPort);
      const app = await startApp({ profiles: [testProfile({ name: 'local', amqpUrl: `amqp://127.0.0.1:${proxy.port}` })] });
      try {
        await seedMessages('/', queue, 3);
        expect((await app.post(startPath(queue, 'local'))).status).toBe(201);

        // In one tick: the Checkout is still active here, and the drop arrives during its end.
        proxy.cut();
        expect(await settledWithin(app.close(), 8_000)).toBe(true);

        await eventually(async () => expect(await readyCount('/', queue)).toBe(3));
      } finally {
        await proxy.close();
      }
    }, 30_000);

    it.each([CLASSIC, QUORUM])('closes within its limits with a live Checkout of %s when the broker goes silent', async (queue) => {
      const proxy = await startTcpProxy(testBroker.amqpPort);
      const app = await startApp({ profiles: [testProfile({ name: 'local', amqpUrl: `amqp://127.0.0.1:${proxy.port}` })] });
      try {
        await seedMessages('/', queue, 3);
        expect((await app.post(startPath(queue, 'local'))).status).toBe(201);

        proxy.silence();
        expect(await settledWithin(app.close(), 25_000)).toBe(true);
      } finally {
        await proxy.close();
      }
    }, 60_000);
  });
});
