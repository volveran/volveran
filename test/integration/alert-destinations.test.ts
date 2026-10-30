// Alert Destinations and test notifications: an admin checks that a destination
// works before any Alert Rule exists. What a receiver gets, what the API
// answers, and what the audit store keeps.
import { createHmac } from 'node:crypto';
import { rm } from 'node:fs/promises';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { AuditStore } from '../../src/server/audit/store.js';
import { closedPort, makeTempDir, startApp, testProfile, type TestApp } from './harness.js';
import { startFakeReceiver, type FakeReceiver } from './fake-receiver.js';
import { teamModeEnv, TestBrowser } from './oidc-provider.js';

const destinations = [
  { name: 'ops-slack', type: 'slack', urlEnv: 'SLACK_URL' },
  { name: 'ops-teams', type: 'teams', urlEnv: 'TEAMS_URL' },
  { name: 'pager', type: 'webhook', urlEnv: 'HOOK_URL', signingSecretEnv: 'HOOK_SECRET' },
];
const SECRET = 'whsec-test';

describe('test notifications', () => {
  let receiver: FakeReceiver;
  let app: TestApp;
  let dataDir: string;

  beforeAll(async () => {
    receiver = await startFakeReceiver();
    dataDir = await makeTempDir('alert-destinations');
    app = await startApp({
      profiles: [testProfile({ name: 'local' })],
      alertDestinations: destinations,
      dataDir,
      env: {
        SLACK_URL: `${receiver.url}/slack`,
        TEAMS_URL: `${receiver.url}/teams`,
        HOOK_URL: `${receiver.url}/webhook`,
        HOOK_SECRET: SECRET,
        VOLVERAN_PUBLIC_URL: 'https://volveran.example.com',
      },
    });
  });
  afterEach(() => {
    receiver.received.length = 0;
    receiver.answerWith();
  });
  afterAll(async () => {
    await app.close();
    await receiver.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  const test = (name: string) => app.post(`/api/alert-destinations/${name}/test`);

  it('reaches a Slack destination as a labelled incoming-webhook message', async () => {
    const res = await test('ops-slack');
    expect(res.status).toBe(200);
    expect(res.body.delivery).toMatchObject({ destination: 'ops-slack', destinationType: 'slack', test: true, outcome: 'delivered', httpStatus: 200, attempts: 1 });
    expect(receiver.received).toHaveLength(1);
    const [request] = receiver.received;
    expect(request!.path).toMatch(/\/slack$/);
    expect(request!.headers['content-type']).toBe('application/json');
    expect(request!.json.text).toContain('Test notification');
    expect(request!.json.blocks[0]).toEqual({ type: 'header', text: { type: 'plain_text', text: 'Test notification from Volverán' } });
    expect(request!.text).toContain('<https://volveran.example.com/|');
  });

  it('reaches a Teams destination as a labelled Adaptive Card', async () => {
    expect((await test('ops-teams')).body.delivery).toMatchObject({ destinationType: 'teams', outcome: 'delivered' });
    const { json } = receiver.received[0]!;
    expect(json.type).toBe('message');
    expect(json.attachments[0].contentType).toBe('application/vnd.microsoft.card.adaptive');
    expect(json.attachments[0].content.body[0].text).toBe('Test notification from Volverán');
    expect(json.attachments[0].content.actions[0].url).toBe('https://volveran.example.com/');
  });

  it('reaches a webhook as the documented body, with a signature that verifies', async () => {
    const before = Math.floor(Date.now() / 1000);
    const res = await test('pager');
    expect(res.body.delivery).toMatchObject({ destinationType: 'webhook', outcome: 'delivered' });
    const { json, headers, text } = receiver.received[0]!;
    expect(json).toEqual({
      version: 1,
      test: true,
      alertId: res.body.delivery.alertId,
      status: 'firing',
      rule: 'Test notification',
      profile: null,
      vhost: null,
      queue: null,
      condition: 'test',
      value: null,
      threshold: null,
      startedAt: expect.any(String),
      endedAt: null,
      url: 'https://volveran.example.com/',
    });
    const timestamp = headers['x-volveran-timestamp'] as string;
    expect(Number(timestamp)).toBeGreaterThanOrEqual(before);
    expect(headers['x-volveran-signature']).toBe(`sha256=${createHmac('sha256', SECRET).update(`${timestamp}.${text}`).digest('hex')}`);
  });

  it('retries a receiver answering 500 twice, and records the delivery on the third attempt', async () => {
    receiver.answerWith(500, 500, 200);
    const started = Date.now();
    const res = await test('pager');
    expect(res.body.delivery).toMatchObject({ outcome: 'delivered', httpStatus: 200, attempts: 3 });
    expect(receiver.received).toHaveLength(3);
    // Back-off: 1 s, then 2 s.
    expect(Date.now() - started).toBeGreaterThanOrEqual(2900);
    const ids = new Set(receiver.received.map((r) => r.json.alertId));
    expect(ids.size).toBe(1);
  });

  it('records one that keeps failing as failed, with its status', async () => {
    receiver.answerWith(503, 503, 503);
    const res = await test('ops-slack');
    expect(res.status).toBe(200);
    expect(res.body.delivery).toMatchObject({ outcome: 'failed', httpStatus: 503, error: null, attempts: 3 });
    expect(receiver.received).toHaveLength(3);
  });

  it('answers 404 for a destination the file does not declare', async () => {
    const res = await test('nope');
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('alert_destination_not_found');
  });

  it('never returns a URL', async () => {
    const res = await test('pager');
    expect(JSON.stringify(res.body)).not.toContain('secret-token');
    expect(JSON.stringify(res.body)).not.toContain('127.0.0.1');
  });

  it('records the outcome in the audit store, without the URL', async () => {
    const res = await test('ops-teams');
    expect(res.body.delivery.outcome).toBe('delivered');
    // Nothing reads outcomes through the API yet (the Alerts view, #81); WAL lets a second connection look.
    const store = new AuditStore(dataDir);
    try {
      expect(store.notifications.recent(1)[0]).toMatchObject({ id: res.body.delivery.id, destination: 'ops-teams', outcome: 'delivered', test: true });
      expect(JSON.stringify(store.notifications.recent())).not.toContain('secret-token');
    } finally {
      store.close();
    }
  });
});

describe('a receiver that cannot be reached', () => {
  it('is recorded as failed with the error code, and no URL', async () => {
    const port = await closedPort();
    const app = await startApp({
      profiles: [testProfile({ name: 'local' })],
      alertDestinations: [{ name: 'gone', type: 'webhook', urlEnv: 'GONE_URL' }],
      env: { GONE_URL: `http://127.0.0.1:${port}/secret-token` },
    });
    try {
      const res = await app.post('/api/alert-destinations/gone/test');
      expect(res.body.delivery).toMatchObject({ outcome: 'failed', httpStatus: null, error: 'ECONNREFUSED', attempts: 3 });
      expect(JSON.stringify(res.body)).not.toContain('secret-token');
    } finally {
      await app.close();
    }
  });
});

describe('startup', () => {
  it('refuses a destination whose variable is unset, naming the place in the file', async () => {
    await expect(
      startApp({ profiles: [testProfile({ name: 'local' })], alertDestinations: [destinations[0]!] }),
    ).rejects.toThrow('alertDestinations[0] ("ops-slack").urlEnv names SLACK_URL, which is not set');
  });

  it('starts as before without any destination', async () => {
    const app = await startApp({ profiles: [testProfile({ name: 'local' })] });
    try {
      expect((await app.post('/api/alert-destinations/any/test')).status).toBe(404);
    } finally {
      await app.close();
    }
  });
});

describe('test notifications in Team Mode', () => {
  let receiver: FakeReceiver;
  let app: TestApp;
  let baseUrl: string;

  beforeAll(async () => {
    receiver = await startFakeReceiver();
    const port = await closedPort();
    baseUrl = `http://127.0.0.1:${port}`;
    app = await startApp({
      port,
      profiles: [
        testProfile({ name: 'prod', roles: { viewer: ['support'], operator: ['oncall'], admin: ['prod-admins'] } }),
        testProfile({ name: 'staging', roles: { admin: ['staging-admins'] } }),
      ],
      alertDestinations: [{ name: 'pager', type: 'webhook', urlEnv: 'HOOK_URL' }],
      env: { ...teamModeEnv(baseUrl), HOOK_URL: receiver.url },
    });
  });
  afterAll(async () => {
    await app.close();
    await receiver.close();
  });

  async function as(sub: string, groups: string[]) {
    const browser = new TestBrowser(baseUrl);
    await browser.signIn({ sub, email: `${sub}@example.com`, groups });
    return browser;
  }

  it.each([
    ['a viewer', ['support']],
    ['an operator', ['oncall']],
    ['someone with no role', ['marketing']],
  ])('refuses %s, and sends nothing', async (_who, groups) => {
    const res = await (await as('low', groups)).post('/api/alert-destinations/pager/test');
    expect(res.status).toBe(403);
    expect(res.body.error).toMatchObject({ code: 'role_required', required: 'admin' });
    expect(JSON.stringify(res.body)).not.toContain('secret-token');
    expect(receiver.received).toHaveLength(0);
  });

  it('refuses without saying whether the destination exists', async () => {
    const res = await (await as('low', ['support'])).post('/api/alert-destinations/nope/test');
    expect(res.status).toBe(403);
  });

  it('refuses without a session', async () => {
    expect((await app.post('/api/alert-destinations/pager/test')).status).toBe(401);
  });

  it('lets an admin of any profile send one, and links to the origin of the redirect URL', async () => {
    const res = await (await as('ada', ['staging-admins'])).post('/api/alert-destinations/pager/test');
    expect(res.status).toBe(200);
    expect(res.body.delivery.outcome).toBe('delivered');
    expect(receiver.received.at(-1)!.json.url).toBe(`${baseUrl}/`);
  });
});
