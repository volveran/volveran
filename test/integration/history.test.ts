// Depth history against the real broker, with the sampler's test clock and
// "sample now" (samplerHooks): Samples of the dead-letter queues, estimated
// arrivals, gaps, marks for what triage took out, access, retention, and what
// the sampler offers later consumers (the latest snapshot and finished runs).
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { rm } from 'node:fs/promises';
import { afterEach, describe, expect, it } from 'vitest';
import {
  applyAndWait,
  closedPort,
  deadLetter,
  deadLetterRoutes,
  eventually,
  fixtureQueues,
  makeTempDir,
  purgeQueues,
  samplerHooks,
  startApp,
  testProfile,
  withChannel,
  type TestApp,
} from './harness.js';
import { teamModeEnv, TestBrowser } from './oidc-provider.js';

const route = deadLetterRoutes.classic;
const dlq = route.dlq;
const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;
const historyPath = (profile: string, queue: string = dlq, range = '') => `/api/profiles/${profile}/vhosts/%2F/queues/${encodeURIComponent(queue)}/history${range}`;
const everything = () => `?from=${new Date(Date.now() - 7 * DAY).toISOString()}&to=${new Date(Date.now() + DAY).toISOString()}`;

const messages = (prefix: string, count: number) =>
  Array.from({ length: count }, (_, i) => ({ body: `${prefix}-${i}`, options: { messageId: `${prefix}-${i}` } }));

describe('depth history', () => {
  const apps: TestApp[] = [];
  const cleanups: Array<() => Promise<unknown>> = [];
  async function start(options: Parameters<typeof startApp>[0]) {
    const app = await startApp(options);
    apps.push(app);
    return app;
  }
  afterEach(async () => {
    while (apps.length) await apps.pop()!.close();
    while (cleanups.length) await cleanups.pop()!();
    await purgeQueues('/', fixtureQueues);
  });

  /** Waits until management statistics show the depth, as the sampler would read it. */
  async function waitForDepth(app: TestApp, depth: number, queue: string = dlq, profile = 'local') {
    await eventually(async () => {
      const { body } = await app.get(`/api/profiles/${profile}/vhosts/%2F/queues`);
      expect(body.queues.find((q: any) => q.name === queue)?.approximateMessages).toBe(depth);
    }, 30_000, 250);
  }

  /** Discards `count` Messages of the queue in one Apply; returns the Checkout's id. */
  async function discard(app: TestApp, count: number, queue: string = dlq): Promise<string> {
    const { checkout } = (await app.post(`/api/profiles/local/vhosts/%2F/queues/${encodeURIComponent(queue)}/checkouts`)).body;
    const handles = checkout.messages.slice(0, count).map((m: any) => m.handle);
    await app.post(`/api/checkouts/${checkout.id}/decisions`, { handles, decision: { kind: 'discard', reason: 'bad payload' } });
    expect((await applyAndWait(app, `/api/checkouts/${checkout.id}/apply`, { confirm: true })).status).toBe(202);
    return checkout.id;
  }

  it('shows depth and estimated arrivals after dead-lettering through real queues, also while triage takes Messages out', async () => {
    const sampler = samplerHooks();
    const app = await start({ profiles: [testProfile({ name: 'local' })], samplerTestHooks: sampler.hooks });
    /** A run at the wall clock, because Audit Entries carry real time. */
    const sample = async () => {
      sampler.set(new Date());
      await sampler.sampleNow();
    };

    await sample();
    await deadLetter(route, messages('first', 3));
    await waitForDepth(app, 3);
    await sample();
    // 2 taken out and 5 arrived: depth goes from 3 to 6, which alone would say 3.
    const checkoutId = await discard(app, 2);
    await deadLetter(route, messages('second', 5));
    await waitForDepth(app, 6);
    await sample();
    // Only taken out: no arrivals.
    await discard(app, 6);
    await waitForDepth(app, 0);
    await sample();

    const { status, body } = await app.get(historyPath('local', dlq, everything()));
    expect(status).toBe(200);
    expect(body.samples.map((s: any) => [s.depth, s.estimatedArrivals])).toEqual([
      [0, null],
      [3, 3],
      [6, 5],
      [0, 0],
    ]);
    expect(body.latestSampleAt).toBe(body.samples.at(-1).at);
    expect(body.gaps).toEqual([]);
    expect(body.marks[0]).toMatchObject({ kind: 'apply', checkoutId, counts: { discard: 2, replay: 0, move: 0 }, rule: null });
    expect(body.marks[0].operator).toBeTruthy();
    expect(body.marks[1].counts.discard).toBe(6);

    const entries = (await app.get(body.marks[0].auditUrl)).body.entries;
    expect(entries.map((e: any) => [e.action, e.checkoutId, e.queue])).toEqual([
      ['discard', checkoutId, dlq],
      ['discard', checkoutId, dlq],
    ]);
  });

  it('samples on its timer, only the dead-letter queues', async () => {
    const sampler = samplerHooks();
    const app = await start({ profiles: [testProfile({ name: 'local' })], samplerTestHooks: sampler.hooks });
    const runs: string[] = [];
    sampler.onRun(({ run }) => void runs.push(run.profile));

    sampler.advance(MINUTE - 1);
    expect(runs).toEqual([]);
    sampler.advance(1);
    await eventually(async () => expect(runs).toEqual(['local']));
    sampler.advance(MINUTE);
    await eventually(async () => expect(runs).toEqual(['local', 'local']));

    const range = `?from=${new Date(sampler.now().getTime() - DAY).toISOString()}&to=${sampler.now().toISOString()}`;
    expect((await app.get(historyPath('local', dlq, range))).body.samples).toHaveLength(2);
    expect((await app.get(historyPath('local', route.workQueue, range))).body.samples).toEqual([]);
    expect((await app.get(historyPath('local', 'triage.manual', range))).body.samples).toEqual([]);
  });

  it('shows gaps for a profile whose broker is unreachable, while another keeps being sampled', async () => {
    const sampler = samplerHooks();
    const nowhere = await closedPort();
    const app = await start({
      profiles: [
        testProfile({ name: 'local' }),
        testProfile({ name: 'down', managementUrl: `http://127.0.0.1:${nowhere}`, amqpUrl: `amqp://127.0.0.1:${nowhere}`, vhosts: ['/'] }),
      ],
      samplerTestHooks: sampler.hooks,
    });
    const before = sampler.now();
    const runs = await sampler.sampleNow();
    expect(runs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ profile: 'local', ok: true, errorCode: null }),
        expect.objectContaining({ profile: 'down', ok: false, errorCode: expect.any(String) }),
      ]),
    );
    sampler.advance(MINUTE);
    await sampler.sampleNow();
    sampler.advance(MINUTE);
    await sampler.sampleNow();

    const range = `?from=${new Date(before.getTime() - MINUTE).toISOString()}&to=${sampler.now().toISOString()}`;
    const down = (await app.get(historyPath('down', dlq, range))).body;
    expect(down.samples).toEqual([]);
    expect(down.latestSampleAt).toBeNull();
    expect(down.gaps).toEqual([{ from: before.toISOString(), to: sampler.now().toISOString(), errorCode: runs.find((r) => r.profile === 'down')!.errorCode }]);

    const local = (await app.get(historyPath('local', dlq, range))).body;
    expect(local.samples).toHaveLength(3);
    expect(local.gaps).toEqual([]);
  });

  it('does not let a broker that never answers delay another profile', async () => {
    const hung = http.createServer(() => {});
    await new Promise<void>((resolve) => hung.listen(0, '127.0.0.1', resolve));
    cleanups.push(async () => {
      hung.closeAllConnections();
      await new Promise((resolve) => hung.close(resolve));
    });
    const port = (hung.address() as AddressInfo).port;
    const sampler = samplerHooks();
    await start({
      profiles: [
        testProfile({ name: 'hung', managementUrl: `http://127.0.0.1:${port}`, amqpUrl: `amqp://127.0.0.1:${port}`, vhosts: ['/'] }),
        testProfile({ name: 'local' }),
      ],
      samplerTestHooks: sampler.hooks,
    });
    sampler.advance(MINUTE);
    await eventually(async () => {
      const [hungProfile, local] = sampler.latest().profiles;
      expect(local!.lastRun?.ok).toBe(true);
      expect(hungProfile!.lastRun).toBeNull();
    }, 4_000, 50);
  });

  it('samples a queue from the next run once it becomes a dead-letter queue, and keeps the history of a deleted one', async () => {
    const late = 'history.late';
    const source = 'history.late-source';
    const errorQueue = 'history.orders_error';
    const dropAll = () =>
      withChannel('/', async (ch) => {
        for (const q of [source, late, errorQueue]) await ch.deleteQueue(q);
      });
    await withChannel('/', async (ch) => {
      await ch.assertQueue(late);
      await ch.assertQueue(errorQueue);
    });
    cleanups.push(dropAll);
    const sampler = samplerHooks();
    const app = await start({ profiles: [testProfile({ name: 'local' })], samplerTestHooks: sampler.hooks });
    const sampled = () => sampler.latest().profiles[0]!.queues.map((q) => q.queue);

    await eventually(async () => {
      await sampler.sampleNow();
      expect(sampled()).toContain(errorQueue);
    }, 30_000, 250);
    expect(sampled()).not.toContain(late);

    await withChannel('/', async (ch) => {
      await ch.assertQueue(source, { arguments: { 'x-dead-letter-exchange': '', 'x-dead-letter-routing-key': late } });
    });
    sampler.advance(MINUTE);
    await sampler.sampleNow();
    expect(sampled()).toContain(late);
    const at = sampler.now().toISOString();

    await dropAll();
    await eventually(async () => {
      sampler.advance(MINUTE);
      await sampler.sampleNow();
      expect(sampled()).not.toContain(late);
    }, 30_000, 250);
    const range = `?from=${new Date(sampler.now().getTime() - DAY).toISOString()}&to=${sampler.now().toISOString()}`;
    const { body } = await app.get(historyPath('local', late, range));
    expect(body.samples.map((s: any) => s.at)).toContain(at);
  });

  it('marks a Rule Pass that took Messages out, naming the rule', async () => {
    const queue = deadLetterRoutes.quorum.dlq;
    const RULE = 'transient-payments';
    const app = await start({
      profiles: [
        testProfile({
          name: 'local',
          replayRules: [
            { name: RULE, vhost: '/', queue, every: '5m', backoff: { initial: '10m', max: '1h' }, maxAttempts: 1, stopWhen: { diedAgain: 5, within: '15m' } },
          ],
        }),
      ],
    });
    await withChannel('/', async (ch) => {
      const time = { '!': 'timestamp', value: Math.floor((Date.now() - 2 * 3_600_000) / 1000) };
      ch.sendToQueue(queue, Buffer.from('payment'), {
        messageId: 'due-1',
        persistent: true,
        headers: {
          'x-death': [{ queue: deadLetterRoutes.quorum.workQueue, reason: 'rejected', count: 1, time, exchange: 'payments', 'routing-keys': ['payments.captured'] }],
        },
      });
      await ch.waitForConfirms();
    });
    expect((await app.post(`/api/profiles/local/replay-rules/${RULE}/run`)).status).toBe(200);

    const { body } = await app.get(historyPath('local', queue, everything()));
    expect(body.marks).toEqual([
      expect.objectContaining({ kind: 'rule_pass', rule: RULE, counts: { discard: 0, replay: 1, move: 0 } }),
    ]);
    const entries = (await app.get(body.marks[0].auditUrl)).body.entries;
    expect(entries.map((e: any) => [e.action, e.rule, e.messageId])).toEqual([['replay', RULE, 'due-1']]);
  });

  it('keeps the series going across a restart, and removes Samples past the retention', async () => {
    const dir = await makeTempDir('history');
    cleanups.push(() => rm(dir, { recursive: true, force: true }));
    const sampler = samplerHooks(new Date(Date.now() - 3 * DAY));
    const first = await startApp({ profiles: [testProfile({ name: 'local' })], samplerTestHooks: sampler.hooks, dataDir: dir });
    await sampler.sampleNow();
    const old = sampler.now().toISOString();
    expect((await first.get(historyPath('local', dlq, everything()))).body.samples.map((s: any) => s.at)).toEqual([old]);
    sampler.set(new Date());
    await sampler.sampleNow();
    await deadLetter(route, messages('later', 2));
    await waitForDepth(first, 2);
    await first.close();

    const app = await start({
      profiles: [testProfile({ name: 'local' })],
      samplerTestHooks: sampler.hooks,
      dataDir: dir,
      env: { VOLVERAN_HISTORY_RETENTION_DAYS: '1' },
    });
    // What the snapshot knows of the profile survives; its queues wait for a run.
    expect(sampler.latest().profiles[0]).toMatchObject({ lastRun: { ok: true }, queues: [] });
    expect(sampler.latest().profiles[0]!.lastSuccessAt).toEqual(sampler.now());

    sampler.advance(MINUTE);
    await sampler.sampleNow();
    const { samples } = (await app.get(historyPath('local', dlq, everything()))).body;
    expect(samples.map((s: any) => s.at)).not.toContain(old);
    expect(samples.map((s: any) => [s.depth, s.estimatedArrivals])).toEqual([
      [0, 0],
      [2, 2],
    ]);
  });

  it('offers later consumers the latest snapshot and each finished run', async () => {
    const sampler = samplerHooks();
    const nowhere = await closedPort();
    const app = await start({
      profiles: [
        testProfile({ name: 'local' }),
        testProfile({ name: 'down', managementUrl: `http://127.0.0.1:${nowhere}`, amqpUrl: `amqp://127.0.0.1:${nowhere}`, vhosts: ['/'] }),
      ],
      samplerTestHooks: sampler.hooks,
    });
    const finished: any[] = [];
    const unsubscribe = sampler.onRun(async (f) => void finished.push(f));

    await sampler.sampleNow();
    const local = finished.find((f) => f.run.profile === 'local');
    const down = finished.find((f) => f.run.profile === 'down');
    expect(down).toMatchObject({ run: { ok: false }, samples: [] });
    expect(local.run.ok).toBe(true);
    expect(local.samples.map((s: any) => s.queue)).toContain(dlq);

    const [localSnapshot, downSnapshot] = sampler.latest().profiles;
    expect(localSnapshot).toMatchObject({ profile: 'local', lastRun: { ok: true }, lastSuccessAt: sampler.now() });
    expect(localSnapshot!.queues).toEqual(local.samples);
    expect(downSnapshot).toMatchObject({ profile: 'down', lastRun: { ok: false }, lastSuccessAt: null, queues: [] });

    // The same set-up warnings as the queue list.
    const list = (await app.get('/api/profiles/local/vhosts/%2F/queues')).body.queues;
    const warnings = localSnapshot!.queues.map((q) => [q.queue, q.setupWarnings]);
    expect(warnings).toEqual(list.filter((q: any) => q.deadLetterQueue).map((q: any) => [q.name, q.setupWarnings]));
    expect(warnings.some(([, w]) => (w as unknown[]).length > 0)).toBe(true);

    unsubscribe();
    sampler.advance(MINUTE);
    await sampler.sampleNow();
    expect(finished).toHaveLength(2);
  });

  it('answers 400 for a bad range and 404 for a vhost outside the profile', async () => {
    const app = await start({ profiles: [testProfile({ name: 'local', vhosts: ['/'] })] });
    expect((await app.get(historyPath('local', dlq, '?from=yesterday'))).status).toBe(400);
    expect((await app.get(historyPath('local', dlq, '?from=2026-01-02T00:00:00Z&to=2026-01-01T00:00:00Z'))).status).toBe(400);
    expect((await app.get(`/api/profiles/local/vhosts/other/queues/${dlq}/history`)).status).toBe(404);
  });

  describe('access (Team Mode)', () => {
    it('lets any Role read, refuses no Role, and does not sample an operatorToken profile', async () => {
      const port = await closedPort();
      const baseUrl = `http://127.0.0.1:${port}`;
      const sampler = samplerHooks();
      await start({
        profiles: [
          testProfile({ name: 'prod', roles: { viewer: ['support'], admin: ['platform'] } }),
          { name: 'tokens', managementUrl: `http://127.0.0.1:${await closedPort()}`, amqpUrl: 'amqp://127.0.0.1:1', credentials: 'operatorToken', vhosts: ['/'] },
        ],
        port,
        env: teamModeEnv(baseUrl),
        samplerTestHooks: sampler.hooks,
      });
      const runs = await sampler.sampleNow();
      expect(runs.map((r) => r.profile)).toEqual(['prod']);
      expect(sampler.latest().profiles.map((p) => p.profile)).toEqual(['prod']);

      const range = `?from=${new Date(sampler.now().getTime() - DAY).toISOString()}&to=${sampler.now().toISOString()}`;
      const viewer = new TestBrowser(baseUrl);
      await viewer.signIn({ sub: 'vera-sub', email: 'vera@example.com', groups: ['support'] });
      const read = await viewer.get(historyPath('prod', dlq, range));
      expect(read.status).toBe(200);
      expect(read.body.samples).toHaveLength(1);

      const stranger = new TestBrowser(baseUrl);
      await stranger.signIn({ sub: 'nora-sub', email: 'nora@example.com', groups: ['marketing'] });
      const refused = await stranger.get(historyPath('prod', dlq, range));
      expect(refused.status).toBe(403);
      expect(refused.body.error.code).toBe('no_role_on_profile');

      const tokens = await viewer.get(historyPath('tokens', dlq, range));
      expect(tokens.status).toBe(409);
      expect(tokens.body.error.code).toBe('history_not_sampled');
    });
  });
});
