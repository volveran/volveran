// Alert Rules on Volverán itself against the real broker, with the sampler's and
// scheduler's test clocks and a fake Alert Destination: a Replay Rule pausing and resuming,
// a policy that loses Messages coming and going, and a broker out of reach.
import { rm } from 'node:fs/promises';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  closableManagementProxy,
  closedPort,
  deadLetterRoutes,
  eventually,
  makeTempDir,
  management,
  ruleSchedulerHooks,
  samplerHooks,
  startApp,
  testProfile,
  type TestApp,
} from './harness.js';
import { startFakeDestination, type FakeDestination } from './fake-destination.js';

const dlq = deadLetterRoutes.classic.dlq;
const MINUTE = 60_000;
const destinations = [{ name: 'pager', type: 'webhook', urlEnv: 'HOOK_URL' }];
const POLICY = `/policies/%2F/volveran-alerts-test`;
const replayRule = (over: Record<string, unknown> = {}) => ({
  name: 'retry',
  vhost: '/',
  queue: 'payments.gone',
  every: '5m',
  backoff: { initial: '10m', multiplier: 1, max: '10m' },
  maxAttempts: 10,
  stopWhen: { diedAgain: 3, within: '1h' },
  ...over,
});
const alert = (name: string, when: unknown, over: Record<string, unknown> = {}) => ({ name, destinations: ['pager'], when, ...over });

describe('Alert Rules on Volverán itself', () => {
  let destination: FakeDestination;
  const apps: TestApp[] = [];
  const dirs: string[] = [];

  beforeAll(async () => {
    destination = await startFakeDestination();
  });
  afterAll(() => destination.close());
  beforeEach(() => {
    destination.received.length = 0;
  });
  afterEach(async () => {
    while (apps.length) await apps.pop()!.close();
    while (dirs.length) await rm(dirs.pop()!, { recursive: true, force: true });
    await management(POLICY, { method: 'DELETE' });
  });

  async function start(options: Parameters<typeof startApp>[0]) {
    const app = await startApp({ alertDestinations: destinations, env: { HOOK_URL: destination.url }, ...options });
    apps.push(app);
    return app;
  }

  const sent = () => destination.received.map((r) => r.json);
  const expectSent = (count: number) => eventually(async () => expect(destination.received).toHaveLength(count), 10_000, 50);
  const expectNoMore = async (count: number) => {
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(destination.received).toHaveLength(count);
  };

  it('tells of a Replay Rule pausing itself, with the reason, and of its resume', async () => {
    const scheduler = ruleSchedulerHooks();
    const app = await start({
      profiles: [testProfile({ name: 'local', replayRules: [replayRule()], alerts: [alert('stopped', { replayRulePaused: true })] })],
      checkoutTestHooks: scheduler.hooks,
    });

    expect(await scheduler.runPass('local', 'retry')).toMatchObject({ status: 'failed' });
    await expectSent(1);
    expect(sent()[0]).toMatchObject({
      status: 'firing', rule: 'stopped', profile: 'local', condition: 'replayRulePaused', replayRule: 'retry', reason: 'queue_not_found', vhost: null, queue: null, endedAt: null,
    });

    const resumed = await app.post('/api/profiles/local/replay-rules/retry/resume');
    expect(resumed.status).toBe(200);
    await expectSent(2);
    expect(sent()[1]).toMatchObject({ status: 'resolved', alertId: sent()[0].alertId, replayRule: 'retry', reason: 'queue_not_found' });
    expect(sent()[1].endedAt).not.toBeNull();
    await eventually(async () => {
      const { notifications } = (await app.get('/api/alerts')).body;
      expect(notifications.map((n: any) => n.replayRule)).toEqual(['retry', 'retry']);
    });
  });

  it('tells of a pause by an Operator, says nothing of a rule deployed startPaused, and keeps a firing Alert across a restart', async () => {
    const dataDir = await makeTempDir('volveran-alerts');
    dirs.push(dataDir);
    const options = () => {
      const sampler = samplerHooks();
      return {
        sampler,
        start: () =>
          start({
            profiles: [
              testProfile({
                name: 'local',
                replayRules: [replayRule({ name: 'quiet', startPaused: true }), replayRule({ name: 'watched', startPaused: true })],
                alerts: [alert('stopped', { replayRulePaused: true })],
              }),
            ],
            samplerTestHooks: sampler.hooks,
            dataDir,
          }),
      };
    };
    let run = options();
    const app = await run.start();
    await run.sampler.sampleNow();
    await expectNoMore(0);

    // A rule deployed paused has to run before an Operator can pause it.
    expect((await app.post('/api/profiles/local/replay-rules/watched/resume')).status).toBe(200);
    await expectNoMore(0);
    expect((await app.post('/api/profiles/local/replay-rules/watched/pause', { reason: 'payments incident' })).status).toBe(200);
    await expectSent(1);
    expect(sent()[0]).toMatchObject({ status: 'firing', replayRule: 'watched', reason: 'payments incident' });

    await apps.pop()!.close();
    run = options();
    const again = await run.start();
    await run.sampler.sampleNow();
    await expectNoMore(1);

    expect((await again.post('/api/profiles/local/replay-rules/watched/resume')).status).toBe(200);
    await expectSent(2);
    expect(sent()[1]).toMatchObject({ status: 'resolved', alertId: sent()[0].alertId });
  });

  it('fires when a policy gives a dead-letter queue a message-losing set-up warning, and resolves when it is removed', async () => {
    const sampler = samplerHooks();
    const app = await start({
      profiles: [testProfile({ name: 'local', alerts: [alert('losing', { setupWarning: 'loses_messages' })] })],
      samplerTestHooks: sampler.hooks,
    });
    const hasWarning = (present: boolean) =>
      eventually(async () => {
        const { body } = await app.get('/api/profiles/local/vhosts/%2F/queues');
        const codes = body.queues.find((q: any) => q.name === dlq).setupWarnings.map((w: any) => w.code);
        expect(codes.includes('dead_letter_queue_drops_messages')).toBe(present);
      }, 30_000, 250);
    const sample = async () => {
      sampler.set(new Date(sampler.now().getTime() + MINUTE));
      await sampler.sampleNow();
    };

    // Other fixture queues have warnings of their own, and fire for them.
    const aboutDlq = () => sent().filter((n) => n.queue === dlq);
    const expectAboutDlq = (count: number) => eventually(async () => expect(aboutDlq()).toHaveLength(count), 10_000, 50);
    const expectNoMoreAboutDlq = async (count: number) => {
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(aboutDlq()).toHaveLength(count);
    };

    await sample();
    await expectNoMoreAboutDlq(0);

    const put = await management(POLICY, {
      method: 'PUT',
      body: { pattern: `^${dlq.replace(/\./g, '\\.')}$`, definition: { 'message-ttl': 60_000 }, 'apply-to': 'queues' },
    });
    expect(put.status).toBeLessThan(300);
    await hasWarning(true);
    await sample();
    await expectAboutDlq(1);
    expect(aboutDlq()[0]).toMatchObject({ status: 'firing', rule: 'losing', condition: 'setupWarning', vhost: '/', value: 1, reason: 'dead_letter_queue_drops_messages' });
    await sample();
    await expectNoMoreAboutDlq(1);

    await management(POLICY, { method: 'DELETE' });
    await hasWarning(false);
    await sample();
    await expectNoMoreAboutDlq(1);
    await sample();
    await expectAboutDlq(2);
    expect(aboutDlq()[1]).toMatchObject({ status: 'resolved', alertId: aboutDlq()[0].alertId });
  });

  it('resolves samplingFailing when the broker recovers while Volverán keeps running', async () => {
    const broker = await closableManagementProxy();
    const sampler = samplerHooks();
    await start({
      profiles: [testProfile({ name: 'local', managementUrl: broker.url, vhosts: ['/'], alerts: [alert('unsampled', { samplingFailing: { for: '5m' } })] })],
      samplerTestHooks: sampler.hooks,
    });
    const sampleAfter = async (ms: number) => {
      sampler.set(new Date(sampler.now().getTime() + ms));
      return sampler.sampleNow();
    };
    try {
      expect(await sampleAfter(0)).toEqual([expect.objectContaining({ ok: true })]);

      await broker.close();
      expect(await sampleAfter(MINUTE)).toEqual([expect.objectContaining({ ok: false })]);
      await sampleAfter(5 * MINUTE);
      await expectSent(1);
      expect(sent()[0]).toMatchObject({ status: 'firing', rule: 'unsampled', condition: 'samplingFailing', endedAt: null });

      await broker.open();
      expect(await sampleAfter(MINUTE)).toEqual([expect.objectContaining({ ok: true })]);
      await expectSent(2);
      expect(sent()[1]).toMatchObject({ status: 'resolved', alertId: sent()[0].alertId, condition: 'samplingFailing', endedAt: sampler.now().toISOString() });
    } finally {
      await broker.close();
    }
  });

  it('fires samplingFailing after `for` on an unreachable broker, and resolves when it is back', async () => {
    const dataDir = await makeTempDir('volveran-alerts');
    dirs.push(dataDir);
    const rule = alert('unsampled', { samplingFailing: { for: '5m' } });
    const nowhere = await closedPort();
    const sampler = samplerHooks();
    await start({
      profiles: [testProfile({ name: 'local', managementUrl: `http://127.0.0.1:${nowhere}`, amqpUrl: `amqp://127.0.0.1:${nowhere}`, vhosts: ['/'], alerts: [rule] })],
      samplerTestHooks: sampler.hooks,
      dataDir,
    });
    const started = sampler.now().toISOString();
    const sampleAfter = async (s: ReturnType<typeof samplerHooks>, ms: number) => {
      s.set(new Date(s.now().getTime() + ms));
      await s.sampleNow();
    };

    await sampleAfter(sampler, 0);
    await sampleAfter(sampler, 4 * MINUTE);
    await expectNoMore(0);
    await sampleAfter(sampler, MINUTE);
    await expectSent(1);
    expect(sent()[0]).toMatchObject({ status: 'firing', rule: 'unsampled', condition: 'samplingFailing', queue: null, value: 300, threshold: 300, startedAt: started });
    expect(typeof sent()[0].reason).toBe('string');

    // The same profile, its broker back: only the address differs, so restart against the same store.
    await apps.pop()!.close();
    const back = samplerHooks(new Date(sampler.now().getTime() + MINUTE));
    await start({ profiles: [testProfile({ name: 'local', alerts: [rule] })], samplerTestHooks: back.hooks, dataDir });
    await back.sampleNow();
    await expectSent(2);
    expect(sent()[1]).toMatchObject({ status: 'resolved', alertId: sent()[0].alertId, condition: 'samplingFailing', endedAt: back.now().toISOString() });
  });
});
