import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { brokerUsers, startApp, testProfile, type TestApp } from './harness.js';

describe('Broker Profiles and vhosts', () => {
  let app: TestApp;

  beforeAll(async () => {
    app = await startApp({
      profiles: [
        testProfile({ name: 'dev', defaultQueueFilter: '*.dlq' }),
        testProfile({ name: 'prod', vhosts: ['other'], protected: true }),
        testProfile({ name: 'no-password', passwordEnv: 'VOLVERAN_UNSET_PW_FOR_TEST' }),
      ],
    });
  });
  afterAll(async () => {
    await app?.close();
  });

  it('lists the Broker Profiles from the profiles file without exposing passwords', async () => {
    const res = await app.get('/api/profiles');
    expect(res.status).toBe(200);
    expect(res.body.profiles).toEqual([
      expect.objectContaining({ name: 'dev', protected: false, defaultQueueFilter: '*.dlq', username: 'volveran-admin' }),
      expect.objectContaining({ name: 'prod', protected: true, defaultQueueFilter: null, username: 'volveran-admin' }),
      expect.objectContaining({ name: 'no-password' }),
    ]);
    expect(JSON.stringify(res.body)).not.toContain(brokerUsers.admin.password);
  });

  it('says which profiles have their password variable set', async () => {
    const res = await app.get('/api/profiles');
    const byName = Object.fromEntries(res.body.profiles.map((p: any) => [p.name, p]));
    expect(byName['dev']).toMatchObject({ passwordEnv: 'VOLVERAN_TEST_PW_DEV', passwordSet: true });
    expect(byName['no-password']).toMatchObject({ passwordEnv: 'VOLVERAN_UNSET_PW_FOR_TEST', passwordSet: false });
  });

  it('reports a password environment variable that is not set when the profile is used', async () => {
    const res = await app.get('/api/profiles/no-password/vhosts');
    expect(res.status).toBe(500);
    expect(res.body.error.code).toBe('password_not_set');
    expect(res.body.error.message).toContain('VOLVERAN_UNSET_PW_FOR_TEST');
  });

  it('lists every vhost of the broker for a profile configured with "all"', async () => {
    const res = await app.get('/api/profiles/dev/vhosts');
    expect(res.status).toBe(200);
    expect(res.body.vhosts).toEqual([{ name: '/' }, { name: 'other' }]);
  });

  it('lists only the configured vhosts for a profile with a vhost list', async () => {
    const res = await app.get('/api/profiles/prod/vhosts');
    expect(res.body.vhosts).toEqual([{ name: 'other' }]);
  });

  it('refuses a vhost that is not configured for the profile', async () => {
    const res = await app.get('/api/profiles/prod/vhosts/%2F/queues');
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('vhost_not_in_profile');
  });

  it('reports an unknown profile', async () => {
    const res = await app.get('/api/profiles/nope/vhosts');
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('profile_not_found');
  });
});

describe('profiles file validation', () => {
  const profile = (extra: string[]) =>
    [
      'profiles:',
      '  - name: dev',
      '    managementUrl: http://localhost:15672',
      '    amqpUrl: amqp://localhost:5672',
      '    username: guest',
      '    passwordEnv: DEV_PW',
      ...extra,
    ].join('\n');

  it('refuses to start when a profile puts its password in the file', async () => {
    await expect(startApp({ rawYaml: profile(['    password: guest']) })).rejects.toThrow(/passwordEnv/);
  });

  it('refuses to start when a required field is missing', async () => {
    const rawYaml = ['profiles:', '  - name: incomplete', '    username: guest', '    passwordEnv: X'].join('\n');
    await expect(startApp({ rawYaml })).rejects.toThrow(/managementUrl/);
  });

  it('refuses a URL with the wrong scheme', async () => {
    const rawYaml = profile([]).replace('amqp://localhost:5672', 'http://localhost:5672');
    await expect(startApp({ rawYaml })).rejects.toThrow(/amqpUrl must start with amqp:\/\/ or amqps:\/\//);
  });

  it('refuses a CA file it cannot read', async () => {
    await expect(startApp({ rawYaml: profile(['    caFile: /nonexistent/ca.pem']) })).rejects.toThrow(
      /caFile \/nonexistent\/ca.pem/,
    );
  });

  it('refuses an empty profiles file', async () => {
    await expect(startApp({ rawYaml: '' })).rejects.toThrow(/non-empty "profiles" list/);
  });
});
