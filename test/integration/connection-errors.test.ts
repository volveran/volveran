// A Broker Profile that cannot connect is reported with one error kind per
// fix: wrong credentials, unreachable host, missing permissions, TLS failure.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  brokerUsers,
  closedPort,
  startApp,
  startTlsProxy,
  testBroker,
  testProfile,
  tlsFixtures,
  type TestApp,
} from './harness.js';

describe('connection and permission failures', () => {
  let app: TestApp;
  let tlsProxy: Awaited<ReturnType<typeof startTlsProxy>>;

  beforeAll(async () => {
    const deadPort = await closedPort();
    tlsProxy = await startTlsProxy(testBroker.mgmtPort);
    app = await startApp({
      profiles: [
        testProfile({ name: 'wrong-password', passwordEnv: 'VOLVERAN_WRONG_PW' }),
        testProfile({
          name: 'unreachable',
          managementUrl: `http://127.0.0.1:${deadPort}`,
          amqpUrl: `amqp://127.0.0.1:${deadPort}`,
        }),
        testProfile({ name: 'no-vhost-permission', username: brokerUsers.noPerm.username, passwordEnv: 'VOLVERAN_NOPERM_PW' }),
        testProfile({ name: 'not-management', username: brokerUsers.noMgmt.username, passwordEnv: 'VOLVERAN_NOMGMT_PW' }),
        testProfile({ name: 'untrusted-tls', managementUrl: `https://127.0.0.1:${tlsProxy.port}` }),
        testProfile({ name: 'trusted-tls', managementUrl: `https://127.0.0.1:${tlsProxy.port}`, caFile: tlsFixtures.caFile }),
        testProfile({ name: 'plain-to-tls', managementUrl: `http://127.0.0.1:${tlsProxy.port}` }),
      ],
      env: {
        VOLVERAN_WRONG_PW: 'definitely-not-the-password',
        VOLVERAN_NOPERM_PW: brokerUsers.noPerm.password,
        VOLVERAN_NOMGMT_PW: brokerUsers.noMgmt.password,
      },
    });
  });
  afterAll(async () => {
    await app?.close();
    await tlsProxy?.close();
  });

  it('reports rejected credentials without showing the password', async () => {
    const res = await app.get('/api/profiles/wrong-password/vhosts/%2F/queues');
    expect(res.status).toBe(502);
    expect(res.body.error.code).toBe('authentication_failed');
    expect(res.body.error.message).toContain('volveran-admin');
    expect(res.body.error.message).toContain('VOLVERAN_WRONG_PW');
    expect(res.body.error.message).not.toContain('definitely-not-the-password');
  });

  it('reports an unreachable broker', async () => {
    const res = await app.get('/api/profiles/unreachable/vhosts');
    expect(res.status).toBe(502);
    expect(res.body.error.code).toBe('broker_unreachable');
    expect(res.body.error.message).toMatch(/ECONNREFUSED/);
  });

  it('reports a vhost the user has no permissions on', async () => {
    const res = await app.get('/api/profiles/no-vhost-permission/vhosts/%2F/queues');
    expect(res.status).toBe(502);
    expect(res.body.error.code).toBe('vhost_not_accessible');
    expect(res.body.error.message).toContain('volveran-noperm');
  });

  it('still lists the vhosts the user can access', async () => {
    const res = await app.get('/api/profiles/no-vhost-permission/vhosts');
    expect(res.body.vhosts).toEqual([{ name: 'other' }]);
  });

  it('reports a user without access to the management API', async () => {
    const res = await app.get('/api/profiles/not-management/vhosts/%2F/queues');
    expect(res.status).toBe(502);
    expect(res.body.error.code).toBe('not_management_user');
    expect(res.body.error.message).toContain('management');
  });

  it('reports a certificate the profile does not trust, suggesting caFile', async () => {
    const res = await app.get('/api/profiles/untrusted-tls/vhosts/%2F/queues');
    expect(res.status).toBe(502);
    expect(res.body.error.code).toBe('tls_failed');
    expect(res.body.error.message).toMatch(/caFile/);
  });

  it('trusts the CA file of the profile for https', async () => {
    const res = await app.get('/api/profiles/trusted-tls/vhosts/%2F/queues');
    expect(res.status).toBe(200);
    expect(res.body.queues.map((q: any) => q.name)).toContain('orders.dlq');
  });

  it('reports a plain http URL pointing at a TLS port as unreachable', async () => {
    const res = await app.get('/api/profiles/plain-to-tls/vhosts');
    expect(res.status).toBe(502);
    expect(res.body.error.code).toBe('broker_unreachable');
  });
});
