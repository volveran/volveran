// Each kind of forwarding under /api and /api/v1 (#129): to the Owner Replica, to the Owner
// Replica of an Approval, to the Background Leader, and the notice a pause sends the leader.
// The route table with forwarding on is compared with the OpenAPI description here too.
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { describedRoutes, readOpenApi, versionedRoutes, type RegisteredRoute } from '../support/api-routes.js';
import { eventually, leaderHooks, purgeQueues, readyCount, seedMessages, testProfile, withChannel } from './harness.js';
import { startTwoReplicas, type ReplicaName, type TwoReplicas } from './two-replicas.js';

const QUEUE = 'api-v1-replicas.dlq';
const OPS = { operator: ['ops'], admin: ['admins'] };
const ana = { sub: 'ana-sub', email: 'ana@example.com', groups: ['ops'] };
const ben = { sub: 'ben-sub', email: 'ben@example.com', groups: ['ops'] };
const admin = { sub: 'adi-sub', email: 'adi@example.com', groups: ['admins'] };
const rule = { name: 'transient', vhost: '/', queue: QUEUE, every: '5m', rate: 100, backoff: { initial: '10m', multiplier: 1, max: '10m' }, maxAttempts: 10, stopWhen: { diedAgain: 50, within: '1h' } };
/** Reachable only over the internal port, so not part of the API. */
const INTERNAL_ROUTE = 'POST /api/v1/profiles/{profile}/replay-rules/{name}/changed';

describe('The API through two Replicas', () => {
  let replicas: TwoReplicas;
  const logs: Record<ReplicaName, Array<Record<string, any>>> = { a: [], b: [] };
  const routes: Record<ReplicaName, RegisteredRoute[]> = { a: [], b: [] };

  beforeAll(async () => {
    await withChannel('/', (ch) => ch.assertQueue(QUEUE, { durable: true }));
    await purgeQueues('/', [QUEUE]);
    const leaders = { a: leaderHooks(new Date()), b: leaderHooks(new Date()) };
    replicas = await startTwoReplicas({
      profiles: [
        testProfile({ name: 'dev', roles: OPS, replayRules: [rule] }),
        testProfile({ name: 'guarded', protected: true, roles: OPS }),
      ],
      perReplica: (name) => ({ leaderTestHooks: leaders[name].hooks, logs: logs[name], onRouteRegistered: (route) => routes[name].push(route) }),
    });
  });

  afterEach(async () => {
    await purgeQueues('/', [QUEUE]);
  });

  afterAll(async () => {
    await replicas?.close();
    await withChannel('/', (ch) => ch.deleteQueue(QUEUE));
  });

  it('registers the described routes, and one of the internal port', () => {
    const versioned = versionedRoutes(routes.a);
    expect(versioned).toContain(INTERNAL_ROUTE);
    expect(versioned.filter((route) => route !== INTERNAL_ROUTE)).toEqual(describedRoutes(readOpenApi()));
  });

  describe.each(['/api', '/api/v1'])('under %s', (prefix) => {
    const signedIn = async (who: typeof ana) => {
      const browser = replicas.browser();
      await browser.to(replicas.a).signIn(who);
      return browser;
    };

    it('serves a Checkout through the Replica that does not own it', async () => {
      await seedMessages('/', QUEUE, 2);
      const browser = await signedIn(ana);
      const started = await browser.to(replicas.a).post(`${prefix}/profiles/dev/vhosts/%2F/queues/${QUEUE}/checkouts`);
      expect(started.status).toBe(201);
      const { id, messages } = started.body.checkout;
      const viaB = browser.to(replicas.b);

      expect((await viaB.get(`${prefix}/checkouts/${id}`)).body.checkout.id).toBe(id);
      expect((await viaB.post(`${prefix}/checkouts/${id}/heartbeat`)).status).toBe(200);
      expect((await viaB.get(`${prefix}/checkouts/${id}/messages/${messages[0].handle}`)).status).toBe(200);
      expect((await viaB.post(`${prefix}/checkouts/${id}/decisions`, { handles: [messages[0].handle], decision: { kind: 'replay' } })).status).toBe(200);

      const exported = await fetch(`${replicas.b.baseUrl}${prefix}/checkouts/${id}/export`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie: [...browser.cookies].map(([k, v]) => `${k}=${v}`).join('; ') },
        body: '{}',
      });
      expect(exported.status).toBe(200);
      expect((await exported.text()).trim().split('\n')).toHaveLength(2);

      // The owner check runs on the owner, under this prefix too.
      const other = await signedIn(ben);
      const refused = await other.to(replicas.b).get(`${prefix}/checkouts/${id}`);
      expect(refused.status).toBe(403);
      expect(refused.body.error.code).toBe('not_checkout_owner');

      expect((await viaB.request('DELETE', `${prefix}/checkouts/${id}`)).status).toBe(200);
      await eventually(async () => expect(await readyCount('/', QUEUE)).toBe(2));
    });

    it('serves an Approval through the Replica that does not own it', async () => {
      await seedMessages('/', QUEUE, 1);
      const requester = await signedIn(ana);
      const started = await requester.to(replicas.a).post(`${prefix}/profiles/guarded/vhosts/%2F/queues/${QUEUE}/checkouts`);
      expect(started.status).toBe(201);
      const { id, messages } = started.body.checkout;
      const decided = await requester.to(replicas.a).post(`${prefix}/checkouts/${id}/decisions`, { handles: [messages[0].handle], decision: { kind: 'discard', reason: 'bad' } });
      expect(decided.status).toBe(200);
      const requested = await requester.to(replicas.b).post(`${prefix}/checkouts/${id}/approval-request`, { confirm: true, confirmQueueName: QUEUE });
      expect(requested.status).toBe(200);

      const approver = await signedIn(ben);
      const viaB = approver.to(replicas.b);
      expect((await viaB.get(`${prefix}/approvals`)).body.approvals.map((a: { checkoutId: string }) => a.checkoutId)).toEqual([id]);
      expect((await viaB.get(`${prefix}/approvals/${id}`)).body.checkout.id).toBe(id);
      expect((await viaB.post(`${prefix}/approvals/${id}/reject`, { reason: 'not yet' })).status).toBe(200);

      expect((await requester.to(replicas.b).request('DELETE', `${prefix}/checkouts/${id}`)).status).toBe(200);
      await eventually(async () => expect(await readyCount('/', QUEUE)).toBe(1));
    });

    it('runs a Run now on the leader, and tells the leader of a pause, through the other Replica', async () => {
      const browser = await signedIn(admin);
      const viaB = browser.to(replicas.b);
      const rulePath = `${prefix}/profiles/dev/replay-rules/${rule.name}`;

      const run = await viaB.post(`${rulePath}/run`);
      expect(run.status).toBe(200);
      expect(run.body.pass.status).toBeDefined();

      const told = logs.b.length;
      expect((await viaB.post(`${rulePath}/pause`, { reason: 'incident' })).status).toBe(200);
      expect((await browser.to(replicas.a).post(`${rulePath}/resume`)).status).toBe(200);
      expect(logs.b.slice(told).filter((line) => String(line.msg).includes('could not be told'))).toEqual([]);
    });

    it('answers the internal route only on the internal port', async () => {
      const browser = await signedIn(admin);
      const path = `${prefix}/profiles/dev/replay-rules/${rule.name}/changed`;
      const onWebPort = await browser.to(replicas.a).post(path);
      expect(onWebPort.status).toBe(404);
      const noSecret = await fetch(replicas.a.forwardingUrl + path, { method: 'POST' });
      expect(noSecret.status).toBe(401);
    });
  });
});
