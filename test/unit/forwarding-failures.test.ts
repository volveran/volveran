// How a Replica tells forwarding failures apart. The one that needs real Replicas (the
// owner has gone) is in metrics-two-replicas.test.ts; these need a Replica that never answers.
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { attachOperator } from '../../src/server/operator.js';
import { createForwarder, type ForwardingFailure } from '../../src/server/replicas/forwarding.js';

const ana = { id: 'ana', displayName: 'Ana' };

describe('forwarding failures', () => {
  let app: FastifyInstance;
  let silent: http.Server;
  afterEach(async () => {
    await app.close();
    silent.closeAllConnections();
    await new Promise((resolve) => silent.close(resolve));
  });

  /** A web port forwarding to a Replica that accepts a request and never answers it. */
  async function start(failures: ForwardingFailure[], onRequest: () => void = () => {}) {
    silent = http.createServer(() => onRequest());
    await new Promise<void>((resolve) => silent.listen(0, '127.0.0.1', resolve));
    const address = `127.0.0.1:${(silent.address() as AddressInfo).port}`;
    const forwarder = createForwarder('secret', (reason) => failures.push(reason));
    app = Fastify();
    attachOperator(app, () => ana);
    app.get('/api/thing', forwarder.toOwner(async () => address, { answerWithinMs: 500 }), async () => 'here');
    await app.listen({ host: '127.0.0.1', port: 0 });
    return { url: `http://127.0.0.1:${(app.server.address() as AddressInfo).port}/api/thing`, forwarder, address };
  }

  it('says when an answer did not begin in time', async () => {
    const failures: ForwardingFailure[] = [];
    const { url } = await start(failures);
    expect((await fetch(url)).status).toBeGreaterThanOrEqual(500);
    expect(failures).toEqual(['timed_out']);
  });

  it('says the same of a notice to another Replica, which rejects', async () => {
    const failures: ForwardingFailure[] = [];
    const { forwarder, address } = await start(failures);
    await expect(forwarder.tell(address, '/api/changed', ana, 100)).rejects.toThrow();
    expect(failures).toEqual(['timed_out']);
  });

  it('counts nothing when it is the Operator who went away', async () => {
    const failures: ForwardingFailure[] = [];
    let arrived = () => {};
    const reached = new Promise<void>((resolve) => (arrived = resolve));
    const { url } = await start(failures, () => arrived());
    const leaving = new AbortController();
    const request = fetch(url, { signal: leaving.signal }).catch(() => null);
    await reached;
    leaving.abort();
    await request;
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(failures).toEqual([]);
  });
});
