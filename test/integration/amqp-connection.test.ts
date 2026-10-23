// openAmqpConnection is the seam Checkouts (#3) open their AMQP connection
// through. No API route opens AMQP connections yet, so this file tests the
// module directly: the same error kinds as the management API, and the
// profile's CA file for amqps.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { openAmqpConnection } from '../../src/server/amqp-connection.js';
import { BrokerError } from '../../src/server/broker-error.js';
import { parseProfiles, type BrokerProfile } from '../../src/server/profiles.js';
import { readFile } from 'node:fs/promises';
import { brokerUsers, closedPort, startTlsProxy, testBroker, tlsFixtures } from './harness.js';

function profile(overrides: Partial<BrokerProfile> = {}): BrokerProfile {
  const [p] = parseProfiles(
    JSON.stringify({
      profiles: [
        {
          name: 'amqp-test',
          managementUrl: testBroker.managementUrl,
          amqpUrl: testBroker.amqpUrl,
          username: brokerUsers.admin.username,
          passwordEnv: 'PW',
        },
      ],
    }),
    { PW: brokerUsers.admin.password },
  );
  return { ...p!, ...overrides };
}

async function failure(p: BrokerProfile, vhost = '/'): Promise<BrokerError> {
  try {
    const conn = await openAmqpConnection(p, vhost, 'volveran test');
    await conn.close();
  } catch (err) {
    if (err instanceof BrokerError) return err;
    throw err;
  }
  throw new Error('connection opened');
}

describe('openAmqpConnection', () => {
  let tlsProxy: Awaited<ReturnType<typeof startTlsProxy>>;
  beforeAll(async () => {
    tlsProxy = await startTlsProxy(testBroker.amqpPort);
  });
  afterAll(async () => {
    await tlsProxy?.close();
  });

  it('opens a named connection to a vhost', async () => {
    const conn = await openAmqpConnection(profile(), 'other', 'volveran test');
    try {
      const ch = await conn.createChannel();
      expect((await ch.checkQueue('other.dlq')).queue).toBe('other.dlq');
    } finally {
      await conn.close();
    }
  });

  it('connects over amqps trusting the profile CA file', async () => {
    const conn = await openAmqpConnection(
      profile({ amqpUrl: `amqps://127.0.0.1:${tlsProxy.port}`, ca: await readFile(tlsFixtures.caFile), caFile: tlsFixtures.caFile }),
      '/',
      'volveran test',
    );
    await conn.close();
  });

  it('reports a certificate it does not trust', async () => {
    const err = await failure(profile({ amqpUrl: `amqps://127.0.0.1:${tlsProxy.port}` }));
    expect(err.code).toBe('tls_failed');
  });

  it('reports rejected credentials', async () => {
    const err = await failure(profile({ password: 'wrong' }));
    expect(err.code).toBe('authentication_failed');
    expect(err.message).not.toContain('wrong');
  });

  it('reports a vhost the user has no permissions on', async () => {
    const err = await failure(profile({ username: brokerUsers.noPerm.username, password: brokerUsers.noPerm.password }));
    expect(err.code).toBe('vhost_not_accessible');
  });

  it('reports an unreachable broker', async () => {
    const err = await failure(profile({ amqpUrl: `amqp://127.0.0.1:${await closedPort()}` }));
    expect(err.code).toBe('broker_unreachable');
    expect(err.message).toMatch(/ECONNREFUSED/);
  });

  it('reports a password variable that is not set', async () => {
    const err = await failure(profile({ password: undefined }));
    expect(err.code).toBe('password_not_set');
  });
});
