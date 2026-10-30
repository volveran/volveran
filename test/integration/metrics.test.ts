// Prometheus metrics, scraped over HTTP on their own port as Prometheus does:
// off unless VOLVERAN_METRICS_PORT is set, no session, nothing on the web
// app's port, loopback in Solo Mode, and each family after the triage it counts.
import net from 'node:net';
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
  samplerHooks,
  seedMessages,
  startApp,
  testBroker,
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

/** The management port behind a proxy: closing it is the broker stopping, as far as Volverán can tell, without stopping the broker the other tests share. */
async function stoppableManagementUrl(): Promise<{ url: string; stop(): Promise<void> }> {
  const sockets = new Set<net.Socket>();
  const server = net.createServer((client) => {
    const upstream = net.connect(Number(new URL(testBroker.managementUrl).port), '127.0.0.1');
    for (const socket of [client, upstream]) {
      sockets.add(socket);
      socket.on('close', () => sockets.delete(socket));
      socket.on('error', () => {
        client.destroy();
        upstream.destroy();
      });
    }
    client.pipe(upstream).pipe(client);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as net.AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    stop: () =>
      new Promise<void>((resolve) => {
        for (const socket of sockets) socket.destroy();
        server.close(() => resolve());
      }),
  };
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

  describe('of dead-letter queues', () => {
    const dlq = route.dlq;
    const depthOf = (queue: string) => `volveran_dead_letter_queue_messages{profile="local",vhost="/",queue="${queue}"}`;
    const arrivalsOf = (queue: string) => `volveran_dead_letter_queue_estimated_arrived_messages_total{profile="local",queue="${queue}",vhost="/"}`;
    const messages = (prefix: string, count: number) =>
      Array.from({ length: count }, (_, i) => ({ body: `${prefix}-${i}`, options: { messageId: `${prefix}-${i}` } }));

    /** Management statistics lag: waits until they show the depth, as the sampler would read it. */
    async function waitForDepth(app: TestApp, depth: number) {
      await eventually(async () => {
        const { body } = await app.get('/api/profiles/local/vhosts/%2F/queues');
        expect(body.queues.find((q: any) => q.name === dlq)?.approximateMessages).toBe(depth);
      }, 30_000, 250);
    }

    it('shows depth, estimated arrivals and set-up warnings per queue, and the sampling state per profile', async () => {
      const sampler = samplerHooks();
      const app = await start({ profiles: [testProfile({ name: 'local' })], samplerTestHooks: sampler.hooks, env: await withMetrics() });
      const sample = async () => {
        sampler.set(new Date());
        await sampler.sampleNow();
      };

      // Nothing sampled yet: the families are there, with no series.
      const before = await scrape(app);
      expect(before).toContain('# TYPE volveran_dead_letter_queue_messages gauge\n');
      expect(before).toContain('# TYPE volveran_dead_letter_queue_estimated_arrived_messages_total counter\n');
      expect(before).not.toContain('volveran_sampling_up{');
      expect(before).not.toContain('volveran_sampling_last_success_timestamp_seconds{');

      // A queue's first Sample has unknown arrivals: no series, not 0.
      await waitForDepth(app, 0);
      await sample();
      const first = await scrape(app);
      expect(first).toContain(`${depthOf(dlq)} 0\n`);
      expect(first).not.toContain(arrivalsOf(dlq));
      expect(first).toContain('volveran_sampling_up{profile="local"} 1\n');
      expect(first).toContain(`volveran_sampling_last_success_timestamp_seconds{profile="local"} ${sampler.now().getTime() / 1000}\n`);
      expect(first).toContain(
        'volveran_dead_letter_queue_setup_warnings{profile="local",vhost="/",queue="orders.dlq.quorum",code="messages_dropped_at_delivery_limit",severity="loses_messages"} 1\n',
      );
      expect(first).not.toContain('volveran_dead_letter_queue_setup_warnings{profile="local",vhost="/",queue="orders.dlq",');
      // Only dead-letter queues.
      expect(first).not.toContain(`queue="${route.workQueue}"`);

      // Known and nothing arrived: a series at 0, so rate() sees the first arrival.
      await sample();
      expect(await scrape(app)).toContain(`${arrivalsOf(dlq)} 0\n`);

      // The counter adds up across Samples.
      await deadLetter(route, messages('first', 3));
      await waitForDepth(app, 3);
      await sample();
      const second = await scrape(app);
      expect(second).toContain(`${depthOf(dlq)} 3\n`);
      expect(second).toContain(`${arrivalsOf(dlq)} 3\n`);

      await deadLetter(route, messages('second', 2));
      await waitForDepth(app, 5);
      await sample();
      const third = await scrape(app);
      expect(third).toContain(`${depthOf(dlq)} 5\n`);
      expect(third).toContain(`${arrivalsOf(dlq)} 5\n`);
    }, 90_000);

    it('answers at once with the last values when the broker stops, and sampling_up turns 0 after the next failed run', async () => {
      const broker = await stoppableManagementUrl();
      const sampler = samplerHooks();
      const app = await start({
        profiles: [testProfile({ name: 'local', managementUrl: broker.url, vhosts: ['/'] })],
        samplerTestHooks: sampler.hooks,
        env: await withMetrics(),
      });
      const sample = async () => {
        sampler.set(new Date());
        return sampler.sampleNow();
      };
      try {
        await waitForDepth(app, 0);
        await sample();
        await deadLetter(route, messages('kept', 3));
        await waitForDepth(app, 3);
        await sample();
        const lastGood = sampler.now().getTime() / 1000;

        await broker.stop();

        // Stopped, and no run has noticed yet: a scrape does not contact the broker.
        const startedAt = Date.now();
        const stale = await scrape(app);
        expect(Date.now() - startedAt).toBeLessThan(1_000);
        expect(stale).toContain('volveran_sampling_up{profile="local"} 1\n');
        expect(stale).toContain(`${depthOf(dlq)} 3\n`);

        // The failed run changes the state, keeps the values and counts nothing twice.
        expect(await sample()).toEqual([expect.objectContaining({ ok: false })]);
        await sample();
        const down = await scrape(app);
        expect(down).toContain('volveran_sampling_up{profile="local"} 0\n');
        expect(down).toContain(`volveran_sampling_last_success_timestamp_seconds{profile="local"} ${lastGood}\n`);
        expect(down).toContain(`${depthOf(dlq)} 3\n`);
        expect(down).toContain(`${arrivalsOf(dlq)} 3\n`);
        expect(down).toContain('volveran_dead_letter_queue_setup_warnings{profile="local",vhost="/",queue="orders.dlq.quorum",');
      } finally {
        await broker.stop();
      }
    }, 90_000);

    it('leaves out an operatorToken profile', async () => {
      const sampler = samplerHooks();
      const port = await closedPort();
      const app = await start({
        profiles: [
          testProfile({ name: 'local' }),
          { name: 'tokens', managementUrl: testBroker.managementUrl, amqpUrl: testBroker.amqpUrl, credentials: 'operatorToken', vhosts: ['/'] },
        ],
        port,
        samplerTestHooks: sampler.hooks,
        env: { ...teamModeEnv(`http://127.0.0.1:${port}`), ...(await withMetrics()) },
      });
      await sampler.sampleNow();
      const text = await scrape(app);
      expect(text).toContain(`${depthOf(dlq)} `);
      expect(text).toContain('volveran_sampling_up{profile="local"} 1\n');
      expect(text).not.toContain('profile="tokens"');
    });
  });
});
