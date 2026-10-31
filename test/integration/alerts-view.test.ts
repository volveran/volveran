// What Operators and scrapers see of Alerts, against the real broker with the
// sampler's test clock and a fake Alert Destination: the alerts API by Role, the Alert Rules,
// the firing Alerts in the queue list, and the two alert metric families.
import { rm } from 'node:fs/promises';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { openTestStore } from './test-store.js';
import {
  closedPort,
  ruleSchedulerHooks,
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
import { startFakeDestination, type FakeDestination } from './fake-destination.js';
import { teamModeEnv, TestBrowser } from './oidc-provider.js';

const route = deadLetterRoutes.classic;
const dlq = route.dlq;
const MINUTE = 60_000;
const messages = (prefix: string, count: number) =>
  Array.from({ length: count }, (_, i) => ({ body: `${prefix}-${i}`, options: { messageId: `${prefix}-${i}` } }));
const queueList = '/api/profiles/prod/vhosts/%2F/queues';

describe('seeing Alerts', () => {
  let destination: FakeDestination;
  let failing: FakeDestination;
  const apps: TestApp[] = [];
  const dirs: string[] = [];

  beforeAll(async () => {
    destination = await startFakeDestination();
    failing = await startFakeDestination();
  });
  afterAll(async () => {
    await destination.close();
    await failing.close();
  });
  beforeEach(() => {
    destination.received.length = 0;
    failing.received.length = 0;
  });
  afterEach(async () => {
    failing.answerWith();
    while (apps.length) await apps.pop()!.close();
    while (dirs.length) await rm(dirs.pop()!, { recursive: true, force: true });
    await purgeQueues('/', fixtureQueues);
  });

  const destinations = [
    { name: 'pager', type: 'webhook', urlEnv: 'HOOK_URL', signingSecretEnv: 'HOOK_SECRET' },
    { name: 'ops-slack', type: 'slack', urlEnv: 'SLACK_URL' },
  ];
  const secrets = () => ({ HOOK_URL: destination.url, HOOK_SECRET: 'whsec-not-for-browsers', SLACK_URL: failing.url });
  const deep = { name: 'deep', destinations: ['pager'], when: { vhost: '/', queue: dlq, depthAbove: 1 }, repeatEvery: '10m' };
  const slow = { name: 'slow', destinations: ['pager', 'ops-slack'], when: { vhost: '/', queue: dlq, depthAbove: 1 }, for: '1h' };

  /** Team Mode: `prod` has both rules, `staging` none, and each Operator has their own Role. */
  async function startTeam(sampler: ReturnType<typeof samplerHooks>, dataDir?: string) {
    const port = await closedPort();
    const baseUrl = `http://127.0.0.1:${port}`;
    const app = await startApp({
      port,
      dataDir,
      profiles: [
        testProfile({ name: 'prod', alerts: [deep, slow], roles: { viewer: ['support'], admin: ['prod-admins'] } }),
        testProfile({ name: 'staging', roles: { viewer: ['staging-viewers'], admin: ['staging-admins'] } }),
      ],
      alertDestinations: destinations,
      samplerTestHooks: sampler.hooks,
      env: { ...teamModeEnv(baseUrl), ...secrets() },
    });
    apps.push(app);
    const as = async (sub: string, groups: string[]) => {
      const browser = new TestBrowser(baseUrl);
      await browser.signIn({ sub, email: `${sub}@example.com`, groups });
      return browser;
    };
    return { app, as };
  }

  async function fillQueue(app: { get(path: string): Promise<{ body: any }> }, count: number) {
    await deadLetter(route, messages('view', count));
    await eventually(async () => {
      const { body } = await app.get(queueList);
      expect(body.queues.find((q: any) => q.name === dlq)?.approximateMessages).toBe(count);
    }, 30_000, 250);
  }

  it('shows firing and pending Alerts and recent notifications, filtered by Role, with no URL or secret anywhere', async () => {
    const sampler = samplerHooks();
    const { as } = await startTeam(sampler);
    const viewer = await as('vera', ['support']);
    await fillQueue(viewer, 3);
    await sampler.sampleNow();
    await eventually(async () => expect(destination.received).toHaveLength(1), 10_000, 50);

    await eventually(async () => {
      const res = await viewer.get('/api/alerts');
      expect(res.status).toBe(200);
      expect(res.body.notifications).toHaveLength(1);
    }, 10_000, 50);
    const seen = (await viewer.get('/api/alerts')).body;
    expect(seen.alerts).toEqual([
      expect.objectContaining({ profile: 'prod', rule: 'deep', status: 'firing', vhost: '/', queue: dlq, condition: 'depthAbove', value: 3, threshold: 1, since: sampler.now().toISOString() }),
      expect.objectContaining({ profile: 'prod', rule: 'slow', status: 'pending', vhost: '/', queue: dlq }),
    ]);
    expect(seen.notifications[0]).toMatchObject({ profile: 'prod', rule: 'deep', destination: 'pager', destinationType: 'webhook', status: 'firing', outcome: 'delivered', httpStatus: 200 });
    expect(seen.destinations).toEqual([{ name: 'pager', type: 'webhook' }, { name: 'ops-slack', type: 'slack' }]);

    const otherProfile = await as('sam', ['staging-viewers']);
    const hidden = (await otherProfile.get('/api/alerts')).body;
    expect(hidden.alerts).toEqual([]);
    expect(hidden.notifications).toEqual([]);

    const noRole = await (await as('nora', ['marketing'])).get('/api/alerts');
    expect(noRole.status).toBe(403);
    expect(noRole.body.error.code).toBe('no_role');

    for (const text of [JSON.stringify(seen), JSON.stringify(hidden), JSON.stringify((await viewer.get('/api/profiles/prod/alert-rules')).body)]) {
      expect(text).not.toContain('secret-token');
      expect(text).not.toContain('127.0.0.1');
      expect(text).not.toContain('whsec');
    }
  });

  it('shows a test notification only to those who may send one', async () => {
    const sampler = samplerHooks();
    const { as } = await startTeam(sampler);
    const admin = await as('ada', ['staging-admins']);
    expect((await admin.post('/api/alert-destinations/pager/test')).status).toBe(200);

    expect((await admin.get('/api/alerts')).body.notifications).toEqual([expect.objectContaining({ test: true, profile: null, destination: 'pager', outcome: 'delivered' })]);
    expect((await (await as('vera', ['support'])).get('/api/alerts')).body.notifications).toEqual([]);
  });

  it('keeps an Operator\'s recent notifications even behind many of a profile they cannot see', async () => {
    const dataDir = await makeTempDir('alerts-view');
    dirs.push(dataDir);
    const store = await openTestStore(dataDir);
    const row = (profile: string, at: Date) => ({
      at, alertId: `${profile}-a`, destination: 'pager', destinationType: 'webhook' as const, status: 'firing' as const, test: false,
      rule: 'deep', profile, vhost: '/', queue: dlq, replayRule: null, outcome: 'delivered' as const, httpStatus: 200, error: null, attempts: 1,
    });
    const now = Date.now();
    await store.notifications.record(row('prod', new Date(now - 10_000)));
    for (let i = 0; i < 150; i++) await store.notifications.record(row('staging', new Date(now - 5_000 + i)));
    await store.close();

    const { as } = await startTeam(samplerHooks(), dataDir);
    const seen = (await (await as('vera', ['support'])).get('/api/alerts')).body.notifications;
    expect(seen.map((n: any) => n.profile)).toEqual(['prod']);
  });

  it('shows an Alert with no vhost and no queue, and puts it on no queue', async () => {
    const dataDir = await makeTempDir('alerts-view');
    dirs.push(dataDir);
    const store = await openTestStore(dataDir);
    const since = Date.UTC(2026, 9, 30, 3, 0);
    await store.alerts.save('prod', {
      arrivals: [],
      alerts: [{ alertId: 'whole-profile', rule: 'deep', vhost: null, queue: null, replayRule: null, reason: null, status: 'firing', condition: 'depthAbove', value: null, threshold: null, since, lastNotifiedAt: since, falseSince: null }],
    });
    await store.close();

    const { as } = await startTeam(samplerHooks(), dataDir);
    const viewer = await as('vera', ['support']);
    expect((await viewer.get('/api/alerts')).body.alerts).toEqual([
      expect.objectContaining({ alertId: 'whole-profile', profile: 'prod', vhost: null, queue: null, value: null, threshold: null, since: new Date(since).toISOString() }),
    ]);
    const { body } = await viewer.get(queueList);
    expect(body.queues.flatMap((q: any) => q.firingAlerts ?? [])).toEqual([]);
  });

  it('lists a profile\'s Alert Rules with destination names and types, by Role', async () => {
    const { as } = await startTeam(samplerHooks());
    const viewer = await as('vera', ['support']);
    expect((await viewer.get('/api/profiles/prod/alert-rules')).body.rules).toEqual([
      { name: 'deep', destinations: [{ name: 'pager', type: 'webhook' }], when: expect.objectContaining({ kind: 'depthAbove', vhost: '/', queue: dlq, threshold: 1 }), forMs: 0, repeatEveryMs: 10 * MINUTE },
      { name: 'slow', destinations: [{ name: 'pager', type: 'webhook' }, { name: 'ops-slack', type: 'slack' }], when: expect.objectContaining({ kind: 'depthAbove' }), forMs: 60 * MINUTE, repeatEveryMs: null },
    ]);
    expect((await viewer.get('/api/profiles/staging/alert-rules')).status).toBe(403);
    expect((await viewer.get('/api/profiles/nope/alert-rules')).status).toBe(404);
  });

  it('carries each queue\'s firing Alerts in the queue list, and not its pending ones', async () => {
    const sampler = samplerHooks();
    const { as } = await startTeam(sampler);
    const viewer = await as('vera', ['support']);
    const row = async () => (await viewer.get(queueList)).body.queues.find((q: any) => q.name === dlq);
    expect((await row()).firingAlerts).toEqual([]);

    await fillQueue(viewer, 3);
    await sampler.sampleNow();

    expect((await row()).firingAlerts).toEqual([
      expect.objectContaining({ rule: 'deep', status: 'firing', condition: 'depthAbove', value: 3, threshold: 1 }),
    ]);
    const others = (await viewer.get(queueList)).body.queues.filter((q: any) => q.name !== dlq);
    expect(others.flatMap((q: any) => q.firingAlerts ?? [])).toEqual([]);
  });

  it('shows Alerts on Volverán itself: a paused Replay Rule, a set-up warning and a broker out of reach', async () => {
    const sampler = samplerHooks();
    const scheduler = ruleSchedulerHooks();
    const replayRule = { name: 'retry', vhost: '/', queue: 'payments.gone', every: '5m', backoff: { initial: '10m', multiplier: 1, max: '10m' }, maxAttempts: 10, stopWhen: { diedAgain: 3, within: '1h' } };
    const when = (name: string, condition: unknown) => ({ name, destinations: ['pager'], when: condition });
    const deadPort = await closedPort();
    const app = await startApp({
      profiles: [
        testProfile({ name: 'prod', replayRules: [replayRule], alerts: [when('stopped', { replayRulePaused: true }), when('stopped-retry', { replayRulePaused: true, rule: 'retry' }), when('losing', { setupWarning: 'loses_messages' })] }),
        testProfile({ name: 'gone', managementUrl: `http://127.0.0.1:${deadPort}`, amqpUrl: `amqp://127.0.0.1:${deadPort}`, vhosts: ['/'], alerts: [when('blind', { samplingFailing: { for: '1m' } })] }),
      ],
      alertDestinations: destinations,
      samplerTestHooks: sampler.hooks,
      checkoutTestHooks: scheduler.hooks,
      env: secrets(),
    });
    apps.push(app);

    await scheduler.runPass('prod', 'retry');
    await sampler.sampleNow();
    sampler.advance(2 * MINUTE);
    await sampler.sampleNow();

    const { alerts } = (await app.get('/api/alerts')).body;
    const named = (rule: string) => alerts.filter((a: any) => a.rule === rule);
    expect(named('stopped')).toEqual([expect.objectContaining({ profile: 'prod', status: 'firing', condition: 'replayRulePaused', replayRule: 'retry', reason: 'queue_not_found', vhost: null, queue: null })]);
    expect(named('losing')).toContainEqual(expect.objectContaining({ condition: 'setupWarning', vhost: '/', queue: 'orders.dlq.quorum', replayRule: null, reason: expect.stringContaining('messages_dropped_at_delivery_limit') }));
    expect(named('blind')).toEqual([expect.objectContaining({ profile: 'gone', status: 'firing', condition: 'samplingFailing', vhost: null, queue: null, replayRule: null, threshold: 60, reason: expect.any(String) })]);

    const rows = (await app.get(queueList)).body.queues;
    const firingOn = (name: string) => rows.find((q: any) => q.name === name).firingAlerts.map((a: any) => a.rule);
    expect(firingOn('orders.dlq.quorum')).toEqual(['losing']);
    expect(firingOn(dlq)).toEqual([]);

    expect((await app.get('/api/profiles/prod/alert-rules')).body.rules.map((r: any) => r.when)).toEqual([
      { kind: 'replayRulePaused', rule: null },
      { kind: 'replayRulePaused', rule: 'retry' },
      { kind: 'setupWarning', severity: 'loses_messages' },
    ]);
    expect((await app.get('/api/profiles/gone/alert-rules')).body.rules[0].when).toEqual({ kind: 'samplingFailing', forMs: MINUTE });
  });

  it('scrapes firing Alerts by rule, and notification outcomes by destination', async () => {
    const sampler = samplerHooks();
    const app = await startApp({
      profiles: [testProfile({
        name: 'prod',
        alerts: [{ ...deep, destinations: ['pager', 'ops-slack'] }, slow],
      })],
      alertDestinations: destinations,
      samplerTestHooks: sampler.hooks,
      env: { ...secrets(), VOLVERAN_METRICS_PORT: String(await closedPort()) },
    });
    apps.push(app);
    const scrape = async () => (await fetch(app.metricsUrl!)).text();

    expect(await scrape()).toContain('volveran_alerts_firing{profile="prod",rule="deep"} 0\n');

    failing.answerWith(500, 500, 500);
    await fillQueue(app, 3);
    await sampler.sampleNow();

    await eventually(async () => {
      const text = await scrape();
      expect(text).toContain('volveran_alert_notifications_total{destination="pager",outcome="delivered"} 1\n');
      expect(text).toContain('volveran_alert_notifications_total{destination="ops-slack",outcome="failed"} 1\n');
    }, 20_000, 100);
    const text = await scrape();
    expect(text).toContain('# TYPE volveran_alerts_firing gauge');
    expect(text).toContain('# TYPE volveran_alert_notifications_total counter');
    expect(text).toContain('volveran_alerts_firing{profile="prod",rule="deep"} 1\n');
    expect(text).toContain('volveran_alerts_firing{profile="prod",rule="slow"} 0\n');

    // A test notification says nothing about Alerts being delivered.
    await app.post('/api/alert-destinations/pager/test');
    expect(await scrape()).toContain('volveran_alert_notifications_total{destination="pager",outcome="delivered"} 1\n');
  });
});
