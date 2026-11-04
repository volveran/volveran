// The demo's API (site/demo/api): what the web app of the release sees when it
// calls /api/v1 in the browser, with no server behind it.
import { describe, expect, it } from 'vitest';
import { createDemoApi } from '../../site/demo/api/demo-api.js';

const origin = 'https://volveran.github.io';

async function call(path: string, init?: RequestInit) {
  const res = await createDemoApi().handle(new Request(`${origin}${path}`, init));
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
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
    expect(await call('/api/v1/alerts')).toEqual({
      status: 404,
      body: { error: { code: 'not_in_demo', message: 'Not in the demo yet: GET /api/v1/alerts.' } },
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

    it('lists the dead-letter queues first, with set-up warnings counted on the whole vhost', async () => {
      const { status, body } = await call('/api/v1/profiles/staging/vhosts/%2F/queues');
      expect(status).toBe(200);
      expect(names(body).slice(0, 2)).toEqual(['orders.dlq', 'payments.dlq']);
      expect(body.defaultQueueFilter).toBe('*.dlq');
      expect(body.setupWarningCounts).toEqual({ loses_messages: 1, may_lose_messages: 0 });
    });

    it('narrows to dead-letter queues and to a search, ignoring case, as the server does', async () => {
      expect(names((await call('/api/v1/profiles/production/vhosts/%2F/queues?search=&onlyDeadLetterQueues=true')).body)).toEqual([
        'orders.dlq',
        'payments.dlq',
      ]);
      const { body } = await call('/api/v1/profiles/production/vhosts/%2F/queues?search=PAY&onlyDeadLetterQueues=false');
      expect(names(body)).toEqual(['payments.dlq', 'payments.work']);
      expect(body.setupWarningCounts).toEqual({ loses_messages: 1, may_lose_messages: 0 });
    });

    it('refuses a vhost the Broker Profile does not have', async () => {
      expect((await call('/api/v1/profiles/staging/vhosts/nope/queues')).body).toEqual({
        error: { code: 'vhost_not_in_profile', message: 'Vhost "nope" is not configured for Broker Profile "staging".' },
      });
    });
  });
});
