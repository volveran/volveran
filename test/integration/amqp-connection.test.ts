// openAmqpConnection is the seam Checkouts (#3) open their AMQP connection
// through. No API route opens AMQP connections yet, so this file tests the
// module directly: the same error kinds as the management API, and the
// profile's CA file for amqps.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { openAmqpConnection } from '../../src/server/amqp-connection.js';
import { brokerCredentials } from '../../src/server/broker-credentials.js';
import { BrokerError } from '../../src/server/broker-error.js';
import { parseProfiles, type BrokerProfile } from '../../src/server/profiles.js';
import { readFile } from 'node:fs/promises';
import { brokerUsers, closedPort, eventually, management, startTlsProxy, testBroker, tlsFixtures } from './harness.js';

/** The test profile; `login` overrides its shared username and password. */
function profile(overrides: Partial<BrokerProfile> = {}, login: { username?: string; password?: string } = {}): BrokerProfile {
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
  return { ...p!, credentials: { ...p!.credentials, ...login } as BrokerProfile['credentials'], ...overrides };
}

/** Opens a connection with the profile's credentials (Solo Mode's Operator: the shared account). */
const open = (p: BrokerProfile, vhost: string) =>
  openAmqpConnection(p, brokerCredentials(p, { id: 'test', displayName: 'test' }), vhost, 'volveran test');

async function failure(p: BrokerProfile, vhost = '/'): Promise<BrokerError> {
  try {
    const conn = await open(p, vhost);
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
    const conn = await open(profile(), 'other');
    try {
      const ch = await conn.createChannel();
      expect((await ch.checkQueue('other.dlq')).queue).toBe('other.dlq');
    } finally {
      await conn.close();
    }
  });

  it("asks for a short heartbeat, unless the profile's URL names its own", async () => {
    const timeoutOf = async (p: BrokerProfile, name: string) => {
      const conn = await openAmqpConnection(p, brokerCredentials(p, { id: 'test', displayName: 'test' }), '/', name);
      try {
        return await eventually(async () => {
          const res = await management('/connections');
          const found = (res.body as Array<{ client_properties?: { connection_name?: string }; timeout?: number }>).find((c) => c.client_properties?.connection_name === name);
          expect(found).toBeDefined();
          return found!.timeout;
        });
      } finally {
        await conn.close();
      }
    };
    expect(await timeoutOf(profile(), 'volveran heartbeat default')).toBe(5);
    expect(await timeoutOf(profile({ amqpUrl: `${testBroker.amqpUrl}?heartbeat=7` }), 'volveran heartbeat own')).toBe(7);
  });

  it('connects over amqps trusting the profile CA file', async () => {
    const conn = await open(
      profile({ amqpUrl: `amqps://127.0.0.1:${tlsProxy.port}`, ca: await readFile(tlsFixtures.caFile), caFile: tlsFixtures.caFile }),
      '/',
    );
    await conn.close();
  });

  it('reports a certificate it does not trust', async () => {
    const err = await failure(profile({ amqpUrl: `amqps://127.0.0.1:${tlsProxy.port}` }));
    expect(err.code).toBe('tls_failed');
  });

  it('reports rejected credentials', async () => {
    const err = await failure(profile({}, { password: 'wrong' }));
    expect(err.code).toBe('authentication_failed');
    expect(err.message).not.toContain('wrong');
  });

  it('reports a vhost the user has no permissions on', async () => {
    const err = await failure(profile({}, { username: brokerUsers.noPerm.username, password: brokerUsers.noPerm.password }));
    expect(err.code).toBe('vhost_not_accessible');
  });

  it('reports an unreachable broker', async () => {
    const err = await failure(profile({ amqpUrl: `amqp://127.0.0.1:${await closedPort()}` }));
    expect(err.code).toBe('broker_unreachable');
    expect(err.message).toMatch(/ECONNREFUSED/);
  });

  it('reports a password variable that is not set', async () => {
    const err = await failure(profile({}, { password: undefined }));
    expect(err.code).toBe('password_not_set');
  });
});
