// Two Replicas on different forwarding protocol versions, as in a rolling update (ADR 0015).
// Both Replicas are real: what stands between them only changes the version a request says it
// speaks, so the refusal and what the sending Replica makes of it are the shipped code.
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closedPort, purgeQueues, seedMessages, testProfile, withChannel } from './harness.js';
import { startTwoReplicas, type TwoReplicas, type ReplicaBrowser } from './two-replicas.js';

const QUEUE = 'forwarding-protocol.dlq';
const PROTOCOL_HEADER = 'x-volveran-forwarding-protocol';
const OPERATOR_HEADER = 'x-volveran-forwarded-operator';
const ana = { sub: 'ana-sub', email: 'ana@example.com', groups: ['ops'] };
const startPath = `/api/profiles/dev/vhosts/%2F/queues/${QUEUE}/checkouts`;
const anaHeader = Buffer.from(JSON.stringify({ id: ana.sub, displayName: ana.email, groups: ana.groups })).toString('base64url');

describe('Replicas on different forwarding protocol versions', () => {
  let two: TwoReplicas;
  let browser: ReplicaBrowser;
  let standIn: http.Server;
  /** What the stand-in makes requests say; null passes them on as they came. */
  let sayVersion: string | null = null;
  let requestsReachingOwner = 0;
  /** The stand-in makes requests carry another secret, as during a rotation. */
  let anotherSecret = false;

  beforeAll(async () => {
    await withChannel('/', async (ch) => {
      await ch.assertQueue(QUEUE, { durable: true });
    });
    await purgeQueues('/', [QUEUE]);
    standIn = http.createServer((req, res) => {
      requestsReachingOwner += 1;
      const { hostname, port } = new URL(two.b.forwardingUrl);
      const headers = { ...req.headers, ...(sayVersion !== null && { [PROTOCOL_HEADER]: sayVersion }), ...(anotherSecret && { authorization: 'Bearer another-secret' }) };
      const out = http.request({ host: hostname, port, method: req.method, path: req.url, headers }, (answer) => {
        res.writeHead(answer.statusCode ?? 502, answer.headers);
        answer.pipe(res);
      });
      out.on('error', () => res.destroy());
      req.pipe(out);
    });
    await new Promise<void>((resolve) => standIn.listen(0, '127.0.0.1', resolve));
    const standInPort = (standIn.address() as AddressInfo).port;
    const metricsPorts = { a: await closedPort(), b: await closedPort() };
    two = await startTwoReplicas({
      profiles: [testProfile({ name: 'dev', roles: { operator: ['ops'] } })],
      perReplica: (name) => ({
        env: {
          VOLVERAN_METRICS_PORT: String(metricsPorts[name]),
          // B's Checkouts are reached through the stand-in.
          ...(name === 'b' && { VOLVERAN_FORWARDING_ADDRESS: `127.0.0.1:${standInPort}` }),
        },
      }),
    });
    browser = two.browser();
    await browser.signIn(ana);
  });

  afterAll(async () => {
    await two.close();
    standIn.closeAllConnections();
    await new Promise((resolve) => standIn.close(resolve));
    await purgeQueues('/', [QUEUE]);
  });

  it('answers try again, acts on nothing and reports nothing lost, and works again once they agree', async () => {
    await seedMessages('/', QUEUE, 2);
    const started = await browser.to(two.b).post(startPath, {});
    expect(started.status).toBe(201);
    const id = started.body.checkout.id as string;

    sayVersion = '2';
    requestsReachingOwner = 0;
    const read = await browser.to(two.a).get(`/api/checkouts/${id}`);
    const end = await browser.to(two.a).post(`/api/checkouts/${id}/end`, {});
    expect(requestsReachingOwner).toBe(2);
    for (const answer of [read, end]) {
      expect(answer.status).toBe(503);
      expect(answer.body.error.code).toBe('replica_unreachable');
      expect(answer.body.error.tryAgain).toBe(true);
    }
    const scrape = await (await fetch(two.a.metricsUrl!)).text();
    expect(scrape).toContain('volveran_forwarding_failures_total{reason="protocol_mismatch"} 2\n');
    // A refusal for this reason is counted once, by the Replica that sent the request.
    expect(await (await fetch(two.b.metricsUrl!)).text()).not.toContain('reason="refused"');

    sayVersion = null;
    const after = await browser.to(two.a).get(`/api/checkouts/${id}`);
    expect(after.status).toBe(200);
    expect(after.body.checkout.status).toBe('active');
    expect(after.body.checkout.messages).toHaveLength(2);
    expect((await browser.to(two.a).post(`/api/checkouts/${id}/end`, {})).status).toBe(200);
  });

  it('answers an Operator try again, not 401, when the Replicas hold different secrets', async () => {
    await seedMessages('/', QUEUE, 1);
    const started = await browser.to(two.b).post(startPath, {});
    expect(started.status).toBe(201);
    const id = started.body.checkout.id as string;
    anotherSecret = true;
    try {
      const read = await browser.to(two.a).get(`/api/checkouts/${id}`);
      expect([read.status, read.body.error.code, read.body.error.tryAgain]).toEqual([503, 'replica_unreachable', true]);
    } finally {
      anotherSecret = false;
    }
    expect((await browser.to(two.a).post(`/api/checkouts/${id}/end`, {})).status).toBe(200);
  });

  describe('the forwarding port', () => {
    const send = (headers: Record<string, string>) => fetch(`${two.b.forwardingUrl}/api/session`, { headers });
    const withSecret = () => ({ authorization: `Bearer ${two.forwardingSecret}`, [OPERATOR_HEADER]: anaHeader });

    it.each([
      ['a later version', { [PROTOCOL_HEADER]: '2' }],
      ['no version', {}],
      ['something that is not a version', { [PROTOCOL_HEADER]: 'one' }],
    ])('refuses %s, saying which it speaks', async (_, version) => {
      const res = await send({ ...withSecret(), ...version });
      expect(res.status).toBe(400);
      expect(res.headers.get(PROTOCOL_HEADER)).toBe('1');
      expect(((await res.json()) as { error: { code: string } }).error.code).toBe('forwarding_protocol_mismatch');
    });

    it('serves the version it speaks', async () => {
      expect((await send({ ...withSecret(), [PROTOCOL_HEADER]: '1' })).status).toBe(200);
    });

    it('tells its version to nobody without the secret', async () => {
      const res = await send({ authorization: 'Bearer wrong', [OPERATOR_HEADER]: anaHeader, [PROTOCOL_HEADER]: '2' });
      expect(res.status).toBe(401);
      expect(res.headers.get(PROTOCOL_HEADER)).toBeNull();
    });
  });
});
