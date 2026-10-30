// Prometheus metrics, scraped over HTTP on their own port as Prometheus does:
// off unless VOLVERAN_METRICS_PORT is set, no session, nothing on the web
// app's port, loopback in Solo Mode, and each family after the triage it counts.
import { networkInterfaces } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import {
  applyAndWait,
  closedPort,
  deadLetter,
  deadLetterRoutes,
  eventually,
  fixtureQueues,
  purgeQueues,
  ruleSchedulerHooks,
  seedMessages,
  startApp,
  testProfile,
  withChannel,
  type TestApp,
} from './harness.js';
import { teamModeEnv, TestBrowser } from './oidc-provider.js';

const QUEUE = 'metrics.dlq';
const route = deadLetterRoutes.quorum;
const RULE = 'transient-payments';
const rule = {
  name: RULE,
  vhost: '/',
  queue: route.dlq,
  every: '5m',
  backoff: { initial: '1s', multiplier: 2, max: '1h' },
  maxAttempts: 5,
  stopWhen: { diedAgain: 50, within: '15m' },
};

async function scrape(app: TestApp): Promise<string> {
  const res = await fetch(app.metricsUrl!);
  expect(res.status).toBe(200);
  expect(res.headers.get('content-type')).toBe('text/plain; version=0.0.4; charset=utf-8');
  return res.text();
}

describe('Metrics', () => {
  const apps: TestApp[] = [];
  async function start(options: Parameters<typeof startApp>[0]) {
    const app = await startApp(options);
    apps.push(app);
    return app;
  }
  const withMetrics = async () => ({ VOLVERAN_METRICS_PORT: String(await closedPort()) });

  afterEach(async () => {
    while (apps.length) await apps.pop()!.close();
    await purgeQueues('/', fixtureQueues);
    await withChannel('/', (ch) => ch.deleteQueue(QUEUE));
  });

  it('opens no listener unless VOLVERAN_METRICS_PORT is set, and the web app\'s port never serves metrics', async () => {
    const off = await start({ profiles: [testProfile({ name: 'local' })] });
    expect(off.metricsUrl).toBeUndefined();
    const offBody = await (await fetch(`${off.baseUrl}/metrics`)).text();
    expect(offBody).not.toContain('volveran_');

    const on = await start({ profiles: [testProfile({ name: 'local' })], env: await withMetrics() });
    const res = await fetch(`${on.baseUrl}/metrics`);
    expect(res.status).toBe(404);
    expect(await res.text()).not.toContain('volveran_');
  });

  it('has no routes but /metrics, and refuses the web app\'s own port', async () => {
    const app = await start({ profiles: [testProfile({ name: 'local' })], env: await withMetrics() });
    const origin = new URL(app.metricsUrl!).origin;
    for (const path of ['/', '/healthz', '/api/profiles']) {
      expect((await fetch(origin + path)).status).toBe(404);
    }
    const port = await closedPort();
    await expect(
      startApp({ profiles: [testProfile({ name: 'local' })], port, env: { VOLVERAN_METRICS_PORT: String(port) } }),
    ).rejects.toThrow(/VOLVERAN_METRICS_PORT/);
  });

  it('listens on loopback only in Solo Mode', async () => {
    const app = await start({ profiles: [testProfile({ name: 'local' })], host: '127.0.0.1', env: await withMetrics() });
    const url = new URL(app.metricsUrl!);
    expect(url.hostname).toBe('127.0.0.1');
    await scrape(app);

    const outside = Object.values(networkInterfaces())
      .flat()
      .find((address) => address && address.family === 'IPv4' && !address.internal);
    if (outside) {
      await expect(fetch(`http://${outside.address}:${url.port}/metrics`)).rejects.toThrow();
    }
  });

  it('shows Rule Passes, Apply outcomes, rule state, stored bodies and the process basics', async () => {
    const scheduler = ruleSchedulerHooks();
    const app = await start({
      profiles: [testProfile({ name: 'local', replayRules: [rule] })],
      checkoutTestHooks: scheduler.hooks,
      env: await withMetrics(),
    });
    expect(await scrape(app)).toContain(`volveran_replay_rule_paused{profile="local",rule="${RULE}",reason=""} 0\n`);

    // A Rule Pass Replays one Message.
    await deadLetter(route, [{ body: 'p-1', options: { messageId: 'p-1' } }]);
    scheduler.advance(60_000);
    expect(await scheduler.runPass('local', RULE)).toMatchObject({ status: 'ran', summary: { replayed: 1 } });

    // An Operator Discards one Message and Keeps another.
    await withChannel('/', (ch) => ch.assertQueue(QUEUE, { durable: true }));
    await seedMessages('/', QUEUE, 2);
    const started = await app.post(`/api/profiles/local/vhosts/%2F/queues/${QUEUE}/checkouts`);
    const { id, messages } = started.body.checkout;
    await app.post(`/api/checkouts/${id}/decisions`, { handles: [messages[0].handle], decision: { kind: 'discard', reason: 'bad payload' } });
    expect((await scrape(app))).toContain('volveran_checkouts_active 1\n');
    const applied = await applyAndWait(app, `/api/checkouts/${id}/apply`, { confirm: true });
    expect(applied.status).toBe(202);

    // An Operator pauses the rule, in words a label must escape.
    await app.post(`/api/profiles/local/replay-rules/${RULE}/pause`, { reason: 'the "payments" team asked' });

    const text = await eventually(async () => {
      const body = await scrape(app);
      expect(body).toContain('nodejs_eventloop_lag_seconds ');
      return body;
    });
    expect(text).toContain(`volveran_replay_rule_paused{profile="local",rule="${RULE}",reason="the \\"payments\\" team asked"} 1\n`);
    expect(text).toContain(`volveran_replay_rule_passes_total{profile="local",result="ran",rule="${RULE}"} 1\n`);
    expect(text).toContain('volveran_apply_messages_total{decision="replay",outcome="done",profile="local"} 1\n');
    expect(text).toContain('volveran_apply_messages_total{decision="discard",outcome="done",profile="local"} 1\n');
    expect(text).not.toContain('decision="keep"');
    expect(text).toContain('volveran_checkouts_active 0\n');
    expect(text).toContain('volveran_approvals_waiting 0\n');
    expect(text).toMatch(/^volveran_audit_store_body_bytes [1-9]\d*$/m);
    for (const name of [
      'process_cpu_user_seconds_total',
      'process_cpu_system_seconds_total',
      'process_resident_memory_bytes',
      'process_start_time_seconds',
      'nodejs_heap_size_used_bytes',
    ]) {
      expect(text).toMatch(new RegExp(`^${name} [0-9.e+-]+$`, 'm'));
    }
  });

  it('shows a waiting Approval to a scraper with no session in Team Mode', async () => {
    await withChannel('/', (ch) => ch.assertQueue(QUEUE, { durable: true }));
    await seedMessages('/', QUEUE, 1);
    const port = await closedPort();
    const baseUrl = `http://127.0.0.1:${port}`;
    const app = await start({
      profiles: [testProfile({ name: 'prod', protected: true, roles: { operator: ['oncall'] } })],
      port,
      env: { ...teamModeEnv(baseUrl), ...(await withMetrics()) },
    });
    const rita = new TestBrowser(baseUrl);
    await rita.signIn({ sub: 'rita-sub', email: 'rita@example.com', groups: ['oncall'] });
    const started = await rita.post(`/api/profiles/prod/vhosts/%2F/queues/${QUEUE}/checkouts`);
    const { id, messages } = started.body.checkout;
    await rita.post(`/api/checkouts/${id}/decisions`, { handles: [messages[0].handle], decision: { kind: 'discard', reason: 'bad payload' } });
    const asked = await rita.post(`/api/checkouts/${id}/approval-request`, { confirm: true, confirmQueueName: QUEUE });
    expect(asked.status).toBe(200);

    expect(await scrape(app)).toContain('volveran_approvals_waiting 1\n');

    await rita.request('DELETE', `/api/checkouts/${id}`);
    expect(await scrape(app)).toContain('volveran_approvals_waiting 0\n');
  });
});
