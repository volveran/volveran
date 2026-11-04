// How a demo handler is registered (site/demo/api/router.ts): the seam later
// demo tickets add their routes through.
import { describe, expect, it } from 'vitest';
import { DemoApiError, json, Router } from '../../site/demo/api/router.js';

const request = (path: string, init?: RequestInit) => new Request(`https://volveran.github.io/api/v1${path}`, init);

describe('the demo router', () => {
  it('gives a handler the decoded path parameters, the query and the JSON body', async () => {
    const router = new Router().on('POST', '/profiles/{profile}/vhosts/{vhost}/queues/{queue}/checkouts', (req) =>
      json({ params: req.params, search: req.query.get('x'), body: req.body }, 201),
    );
    const res = await router.handle(
      request('/profiles/production/vhosts/%2F/queues/orders.dlq/checkouts?x=1', { method: 'POST', body: '{"overrideConsumers":false}' }),
      '/profiles/production/vhosts/%2F/queues/orders.dlq/checkouts',
    );
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({
      params: { profile: 'production', vhost: '/', queue: 'orders.dlq' },
      search: '1',
      body: { overrideConsumers: false },
    });
  });

  it('answers an error a handler throws as the server does', async () => {
    const router = new Router().on('GET', '/checkouts/{id}', ({ params }) => {
      throw new DemoApiError(404, 'checkout_not_found', `No Checkout ${params.id}.`, { tryAgain: false });
    });
    const res = await router.handle(request('/checkouts/c1'), '/checkouts/c1');
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: { code: 'checkout_not_found', message: 'No Checkout c1.', tryAgain: false } });
  });

  it('answers a route left out of the demo with its reason, and lists it apart from those handled', async () => {
    const router = new Router()
      .on('GET', '/session', () => json({}))
      .notInDemo('GET', '/approvals', 'Not in the demo: Approval needs Team Mode.');
    const res = await router.handle(request('/approvals'), '/approvals');
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: { code: 'not_in_demo', message: 'Not in the demo: Approval needs Team Mode.' } });
    expect(router.routes()).toEqual({ handled: ['GET /api/v1/session'], notInDemo: ['GET /api/v1/approvals'] });
  });
});
