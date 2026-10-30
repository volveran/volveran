// Alert Rules on dead-letter queues against the real broker, with the sampler's
// test clock and a fake receiver: what an on-call engineer is sent as the clock
// moves and queues fill and drain.
import { rm } from 'node:fs/promises';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  applyAndWait,
  deadLetter,
  deadLetterRoutes,
  eventually,
  fixtureQueues,
  makeTempDir,
  purgeQueues,
  samplerHooks,
  startApp,
  testProfile,
  type TestApp,
} from './harness.js';
import { startFakeReceiver, type FakeReceiver } from './fake-receiver.js';

const route = deadLetterRoutes.classic;
const dlq = route.dlq;
const MINUTE = 60_000;
const destinations = [{ name: 'pager', type: 'webhook', urlEnv: 'HOOK_URL' }];
const messages = (prefix: string, count: number) =>
  Array.from({ length: count }, (_, i) => ({ body: `${prefix}-${i}`, options: { messageId: `${prefix}-${i}` } }));

describe('Alert Rules on dead-letter queues', () => {
  let receiver: FakeReceiver;
  const apps: TestApp[] = [];
  const dirs: string[] = [];

  beforeAll(async () => {
    receiver = await startFakeReceiver();
  });
  afterAll(() => receiver.close());
  beforeEach(() => {
    receiver.received.length = 0;
  });
  afterEach(async () => {
    while (apps.length) await apps.pop()!.close();
    while (dirs.length) await rm(dirs.pop()!, { recursive: true, force: true });
    await purgeQueues('/', fixtureQueues);
  });

  async function start(alerts: Array<Record<string, unknown>>, sampler: ReturnType<typeof samplerHooks>, dataDir?: string) {
    const app = await startApp({
      profiles: [testProfile({ name: 'local', alerts })],
      alertDestinations: destinations,
      env: { HOOK_URL: receiver.url },
      samplerTestHooks: sampler.hooks,
      dataDir,
    });
    apps.push(app);
    return app;
  }

  async function waitForDepth(app: TestApp, depth: number, queue: string = dlq) {
    await eventually(async () => {
      const { body } = await app.get('/api/profiles/local/vhosts/%2F/queues');
      expect(body.queues.find((q: any) => q.name === queue)?.approximateMessages).toBe(depth);
    }, 30_000, 250);
  }

  const sent = () => receiver.received.map((r) => r.json);
  const expectSent = (count: number) => eventually(async () => expect(receiver.received).toHaveLength(count), 10_000, 50);
  /** Long enough for a notification that should not come to have come. */
  const expectNoMore = async (count: number) => {
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(receiver.received).toHaveLength(count);
  };

  async function discardAll(app: TestApp, count: number) {
    const { checkout } = (await app.post(`/api/profiles/local/vhosts/%2F/queues/${encodeURIComponent(dlq)}/checkouts`)).body;
    const handles = checkout.messages.slice(0, count).map((m: any) => m.handle);
    await app.post(`/api/checkouts/${checkout.id}/decisions`, { handles, decision: { kind: 'discard', reason: 'bad payload' } });
    expect((await applyAndWait(app, `/api/checkouts/${checkout.id}/apply`, { confirm: true })).status).toBe(202);
  }

  it('keeps depthAbove pending under `for`, fires, repeats, and resolves as the clock moves and the queue drains', async () => {
    const sampler = samplerHooks();
    const app = await start(
      [{ name: 'deep', destinations: ['pager'], when: { vhost: '/', queue: dlq, depthAbove: 1 }, for: '5m', repeatEvery: '10m' }],
      sampler,
    );
    const sampleAfter = async (ms: number) => {
      sampler.set(new Date(sampler.now().getTime() + ms));
      await sampler.sampleNow();
    };
    await deadLetter(route, messages('deep', 3));
    await waitForDepth(app, 3);

    await sampleAfter(0);
    const started = sampler.now().toISOString();
    await sampleAfter(4 * MINUTE);
    await expectNoMore(0);

    await sampleAfter(MINUTE);
    await expectSent(1);
    expect(sent()[0]).toMatchObject({
      status: 'firing', rule: 'deep', profile: 'local', vhost: '/', queue: dlq, condition: 'depthAbove', value: 3, threshold: 1, startedAt: started, endedAt: null,
    });
    expect(sent()[0]).not.toHaveProperty('body');

    await sampleAfter(9 * MINUTE);
    await expectNoMore(1);
    await sampleAfter(MINUTE);
    await expectSent(2);
    expect(sent()[1]).toMatchObject({ status: 'firing', alertId: sent()[0].alertId });

    await purgeQueues('/', [dlq]);
    await waitForDepth(app, 0);
    await sampleAfter(MINUTE);
    await expectNoMore(2);
    await sampleAfter(MINUTE);
    await expectSent(3);
    expect(sent()[2]).toMatchObject({ status: 'resolved', alertId: sent()[0].alertId, value: 0 });
    expect(sent()[2].endedAt).toBe(sampler.now().toISOString());
  });

  it('fires arrivalsAbove and anyArrival on Messages that were dead-lettered', async () => {
    const sampler = samplerHooks();
    const app = await start(
      [
        { name: 'burst', destinations: ['pager'], when: { vhost: '/', queue: dlq, arrivalsAbove: { count: 2, within: '10m' } } },
        { name: 'any', destinations: ['pager'], when: { vhost: '/', queue: dlq, anyArrival: true } },
      ],
      sampler,
    );
    await waitForDepth(app, 0);
    await sampler.sampleNow();
    await deadLetter(route, messages('some', 3));
    await waitForDepth(app, 3);
    sampler.set(new Date(sampler.now().getTime() + MINUTE));
    await sampler.sampleNow();
    await expectSent(2);
    const byRule = Object.fromEntries(sent().map((n) => [n.rule, n]));
    expect(byRule.burst).toMatchObject({ condition: 'arrivalsAbove', value: 3, threshold: 2, status: 'firing' });
    expect(byRule.any).toMatchObject({ condition: 'anyArrival', value: 3, status: 'firing' });
  });

  it('does not fire arrival rules when a Discard is all that happened, however the depth lags it', async () => {
    const sampler = samplerHooks();
    const rule = { name: 'any', destinations: ['pager'], when: { vhost: '/', queue: dlq, anyArrival: true } };
    const app = await start([rule], sampler);
    const sample = async () => {
      sampler.set(new Date());
      await sampler.sampleNow();
    };
    await deadLetter(route, messages('old', 5));
    await waitForDepth(app, 5);
    await sample(); // The queue's first Sample: arrivals unknown.
    await sample();
    await discardAll(app, 5);
    await sample(); // Straight after the Discard: management depth is likely still 5.
    await waitForDepth(app, 0);
    await sample();
    await sample();
    await expectNoMore(0);

    await deadLetter(route, messages('new', 2));
    await waitForDepth(app, 2);
    await sample();
    await expectSent(1);
    expect(sent()[0]).toMatchObject({ rule: 'any', value: 2 });
  }, 90_000);

  it('makes each queue matching a queuePattern its own Alert', async () => {
    const sampler = samplerHooks();
    const app = await start([{ name: 'all', destinations: ['pager'], when: { vhost: '/', queuePattern: '*.dlq', depthAbove: 0 } }], sampler);
    await deadLetter(route, messages('one', 1));
    await deadLetter(deadLetterRoutes.quorum, messages('two', 2));
    await waitForDepth(app, 1);
    await waitForDepth(app, 2, deadLetterRoutes.quorum.dlq);
    await sampler.sampleNow();
    await expectSent(2);
    const byQueue = Object.fromEntries(sent().map((n) => [n.queue, n]));
    expect(byQueue[dlq]).toMatchObject({ rule: 'all', value: 1 });
    expect(byQueue[deadLetterRoutes.quorum.dlq]).toMatchObject({ rule: 'all', value: 2 });
    expect(byQueue[dlq].alertId).not.toBe(byQueue[deadLetterRoutes.quorum.dlq].alertId);
  });

  it('sends nothing again when restarted while an Alert fires, and drops a removed rule quietly', async () => {
    const dataDir = await makeTempDir('queue-alerts');
    dirs.push(dataDir);
    const rule = { name: 'deep', destinations: ['pager'], when: { vhost: '/', queue: dlq, depthAbove: 0 } };
    const stop = async () => apps.pop()!.close();

    let sampler = samplerHooks();
    let app = await start([rule], sampler, dataDir);
    await deadLetter(route, messages('kept', 1));
    await waitForDepth(app, 1);
    await sampler.sampleNow();
    await expectSent(1);
    const { alertId } = sent()[0];
    await stop();

    // Restarted: still firing, nothing sent.
    sampler = samplerHooks(new Date(Date.now() + MINUTE));
    app = await start([rule], sampler, dataDir);
    await sampler.sampleNow();
    await expectNoMore(1);
    await stop();

    // The rule is gone from the file: dropped, no resolved notification.
    sampler = samplerHooks(new Date(Date.now() + 2 * MINUTE));
    app = await start([], sampler, dataDir);
    await sampler.sampleNow();
    await sampler.sampleNow();
    await expectNoMore(1);
    await stop();

    // Declared again, it is a new Alert: the old one really was forgotten.
    sampler = samplerHooks(new Date(Date.now() + 3 * MINUTE));
    app = await start([rule], sampler, dataDir);
    await sampler.sampleNow();
    await expectSent(2);
    expect(sent()[1].alertId).not.toBe(alertId);
  });
});
