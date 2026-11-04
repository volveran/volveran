// The demo's API (site/demo/api): what the web app of the release sees when it
// calls /api/v1 in the browser, with no server behind it.
import { describe, expect, it } from 'vitest';
import { createDemoApi } from '../../site/demo/api/demo-api.js';
import { startingState } from '../../site/demo/api/state.js';

const origin = 'https://volveran.github.io';
/** When the demo loads in these tests: long after the screenshot run recorded its answers. */
const now = Date.parse('2027-03-01T12:00:00.000Z');
const hour = 3_600_000;

async function call(path: string, init?: RequestInit) {
  const res = await createDemoApi(startingState(now), () => now).handle(new Request(`${origin}${path}`, init));
  return { status: res.status, body: (await res.json()) as Record<string, any> };
}

describe('the demo API', () => {
  it('answers the session in Solo Mode as the Operator demo, admin on both Broker Profiles', async () => {
    expect(await call('/api/v1/session')).toEqual({
      status: 200,
      body: { mode: 'solo', operator: 'demo', checkoutId: null, roles: { staging: 'admin', production: 'admin' } },
    });
  });

  it('lists staging and production, production a Protected Profile, without reaching a broker', async () => {
    const { status, body } = await call('/api/v1/profiles');
    expect(status).toBe(200);
    expect((body.profiles as Array<{ name: string; protected: boolean }>).map(({ name, protected: p }) => ({ name, protected: p }))).toEqual([
      { name: 'staging', protected: false },
      { name: 'production', protected: true },
    ]);
  });

  it("lists a Broker Profile's vhosts, and refuses a profile it does not have as the server does", async () => {
    expect(await call('/api/v1/profiles/production/vhosts')).toEqual({ status: 200, body: { vhosts: [{ name: '/' }, { name: 'other' }] } });
    expect(await call('/api/v1/profiles/qa/vhosts')).toEqual({
      status: 404,
      body: { error: { code: 'profile_not_found', message: 'No Broker Profile named "qa".' } },
    });
  });

  it('answers a route it has no handler for with a clear "not in the demo yet", whatever the method', async () => {
    expect(await call('/api/v1/nothing-here')).toEqual({
      status: 404,
      body: { error: { code: 'not_in_demo', message: 'Not in the demo yet: GET /api/v1/nothing-here.' } },
    });
    expect((await call('/api/v1/session', { method: 'DELETE' })).body).toEqual({
      error: { code: 'not_in_demo', message: 'Not in the demo yet: DELETE /api/v1/session.' },
    });
  });

  it('takes the /api alias as the server does', async () => {
    expect((await call('/api/session')).body).toMatchObject({ mode: 'solo', operator: 'demo' });
  });

  it('says sign-in needs Team Mode, and never asks to sign in', async () => {
    expect(await call('/auth/logout', { method: 'POST' })).toEqual({
      status: 404,
      body: { error: { code: 'not_in_demo', message: 'Not in the demo: signing in needs Team Mode.' } },
    });
  });

  it('lists the routes it handles and those it leaves out, as the contract check compares them', () => {
    expect(createDemoApi().routes().handled).toEqual(
      expect.arrayContaining([
        'GET /api/v1/profiles',
        'GET /api/v1/profiles/{profile}/vhosts',
        'GET /api/v1/profiles/{profile}/vhosts/{vhost}/queues',
        'GET /api/v1/session',
      ]),
    );
  });

  describe('the queue list', () => {
    const names = (body: Record<string, unknown>) => (body.queues as Array<{ name: string }>).map((q) => q.name);

    it('lists the queues the screenshots show, dead-letter queues first, with set-up warnings counted on the whole vhost', async () => {
      const { status, body } = await call('/api/v1/profiles/staging/vhosts/%2F/queues');
      expect(status).toBe(200);
      expect(names(body).slice(0, 3)).toEqual(['notifications.dlq', 'orders.dlq', 'orders.dlq.quorum']);
      expect(body.defaultQueueFilter).toBe('*.dlq');
      expect(body.setupWarningCounts.loses_messages).toBeGreaterThan(0);
      const billing = body.queues.find((q: { name: string }) => q.name === 'billing.work');
      expect(billing.setupWarnings.map((w: { code: string }) => w.code)).toEqual(['dead_letter_exchange_missing']);
    });

    it("gives a dead-letter queue its last 24 hours of depth, ending when the demo loaded", async () => {
      const { body } = await call('/api/v1/profiles/staging/vhosts/%2F/queues');
      const orders = body.queues.find((q: { name: string }) => q.name === 'orders.dlq');
      // The recording's moment and the server's own clock differ by the time the request took.
      expect(Math.abs(orders.depthSeries.to - now)).toBeLessThan(60_000);
      expect(orders.depthSeries.to - orders.depthSeries.from).toBe(24 * hour);
      const peak = Math.max(...orders.depthSeries.points.map(([, depth]: [number, number]) => depth));
      expect(peak).toBeGreaterThan(200);
      for (const [at] of orders.depthSeries.points) expect(at).toBeLessThanOrEqual(orders.depthSeries.to);
    });

    it('narrows to dead-letter queues and to a search, ignoring case, as the server does', async () => {
      const dlqs = names((await call('/api/v1/profiles/production/vhosts/%2F/queues?search=&onlyDeadLetterQueues=true')).body);
      expect(dlqs).toContain('orders.dlq');
      expect(dlqs).not.toContain('orders.work');
      const { body } = await call('/api/v1/profiles/production/vhosts/%2F/queues?search=PAY&onlyDeadLetterQueues=false');
      expect(names(body)).toEqual(['payments.dlq', 'payments.dlq.classic', 'payments.work']);
    });

    it('refuses a vhost the Broker Profile does not have', async () => {
      expect((await call('/api/v1/profiles/staging/vhosts/nope/queues')).body).toEqual({
        error: { code: 'vhost_not_in_profile', message: 'Vhost "nope" is not configured for Broker Profile "staging".' },
      });
    });
  });

  describe('History', () => {
    const history = (queue: string, range = '') => call(`/api/v1/profiles/staging/vhosts/%2F/queues/${queue}/history${range}`);

    it("answers a queue's last 24 hours up to now by default, with the Apply the screenshots show as a mark by the Operator demo", async () => {
      const { status, body } = await history('orders.dlq');
      expect(status).toBe(200);
      expect(body.to).toBe(new Date(now).toISOString());
      expect(body.from).toBe(new Date(now - 24 * hour).toISOString());
      expect(body.samples.length).toBeGreaterThan(400);
      expect(body.marks).toEqual([
        expect.objectContaining({ kind: 'apply', operator: 'demo', counts: { discard: 1, replay: 2, move: 0 } }),
      ]);
      expect(Date.parse(body.latestSampleAt)).toBeGreaterThan(now - 60_000);
    });

    it('cuts the recording closest in length to the range asked for', async () => {
      const range = new URLSearchParams({ from: new Date(now - hour).toISOString(), to: new Date(now).toISOString() });
      const { body } = await history('orders.dlq', `?${range}`);
      expect(body.from).toBe(range.get('from'));
      expect(body.samples.length).toBeGreaterThan(30);
      expect(body.samples.length).toBeLessThan(120);
      for (const s of body.samples) expect(Date.parse(s.at)).toBeGreaterThanOrEqual(now - hour);
    });

    it('answers an empty history for a queue it has no recording of, and refuses a range that ends before it starts', async () => {
      expect((await history('no.such.queue')).body).toMatchObject({ samples: [], gaps: [], marks: [], latestSampleAt: null });
      const backwards = new URLSearchParams({ from: new Date(now).toISOString(), to: new Date(now - hour).toISOString() });
      expect(await history('orders.dlq', `?${backwards}`)).toEqual({
        status: 400,
        body: { error: { code: 'invalid_request', message: '"from" must not be after "to".' } },
      });
    });
  });

  it('answers Alerts as recorded: the orders.dlq backlog firing since a moment before the demo loaded, its destination without a URL', async () => {
    const { status, body } = await call('/api/v1/alerts');
    expect(status).toBe(200);
    const backlog = body.alerts.find((a: { rule: string }) => a.rule === 'orders-backlog');
    expect(backlog).toMatchObject({ profile: 'staging', queue: 'orders.dlq', status: 'firing', threshold: 5 });
    expect(now - Date.parse(backlog.since)).toBeGreaterThan(0);
    expect(now - Date.parse(backlog.since)).toBeLessThan(hour);
    expect(body.destinations).toEqual([{ name: 'ops-slack', type: 'webhook' }]);
    expect(body.notifications.length).toBeGreaterThan(0);
  });

  it('answers the Dead-letter Map, move destinations, alert rules and Replay rules of each Broker Profile', async () => {
    const map = (await call('/api/v1/profiles/staging/vhosts/%2F/dead-letter-map')).body;
    expect(map.nodes).toEqual(expect.arrayContaining([expect.objectContaining({ id: 'exchange:billing.dlx', missing: true })]));
    const destinations = (await call('/api/v1/profiles/production/vhosts/%2F/move-destinations')).body;
    expect(destinations.queues).toEqual(expect.arrayContaining(['orders.dlq', 'orders.parked']));
    expect(destinations.exchanges).toEqual(expect.arrayContaining([{ name: 'orders', type: 'topic' }]));
    expect((await call('/api/v1/profiles/staging/alert-rules')).body.rules.map((r: { name: string }) => r.name)).toEqual(['orders-backlog', 'losing-messages']);
    const rules = (await call('/api/v1/profiles/staging/replay-rules')).body.rules;
    expect(rules.map((r: { rule: { name: string }; state: { paused: boolean } }) => [r.rule.name, r.state.paused])).toEqual([
      ['db-timeouts', false],
      ['payment-gateway-503', true],
    ]);
    expect(await call('/api/v1/profiles/production/replay-rules')).toEqual({ status: 200, body: { rules: [] } });
    expect((await call('/api/v1/profiles/qa/alert-rules')).body.error.code).toBe('profile_not_found');
  });
});
