// Roles per Broker Profile (Team Mode): the groups claim of the signed-in
// Operator's ID token, mapped by each profile's `roles` to `viewer`,
// `operator` or `admin`. Every route on a profile checks the role before it
// touches the broker or the audit store.
import { rm } from 'node:fs/promises';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { AuditStore } from '../../src/server/audit/store.js';
import { applyAndWait, closedPort, makeTempDir, purgeQueues, readyCount, seedMessages, startApp, testOperator, testProfile, withChannel, type TestApp } from './harness.js';
import { teamModeEnv, TestBrowser, type TestIdentity } from './oidc-provider.js';

const queue = 'triage.manual';
const queuesPath = (profile: string) => `/api/profiles/${profile}/vhosts/%2F/queues`;
const checkoutPath = (profile: string) => `${queuesPath(profile)}/${queue}/checkouts`;

const vera = { sub: 'vera-sub', email: 'vera@example.com', groups: ['support'] };
const otto = { sub: 'otto-sub', email: 'otto@example.com', groups: ['oncall', 'marketing'] };
const ada = { sub: 'ada-sub', email: 'ada@example.com', groups: ['platform'] };
const bea = { sub: 'bea-sub', email: 'bea@example.com', groups: ['support', 'platform', 'oncall'] };
const nora = { sub: 'nora-sub', email: 'nora@example.com', groups: ['marketing'] };
const ned = { sub: 'ned-sub', email: 'ned@example.com' };

describe('Roles per Broker Profile', () => {
  let app: TestApp;
  let baseUrl: string;
  /** A Discard on `prod`, by otto (`operator`). */
  let prodDiscard: any;

  async function signedIn(identity: TestIdentity) {
    const browser = new TestBrowser(baseUrl);
    await browser.signIn(identity);
    return browser;
  }

  /** Starts a Checkout of `queue` on `profile`, Discards every Message and Applies; returns the Audit Entries. */
  async function discardAll(browser: TestBrowser, profile: string) {
    const started = await browser.post(checkoutPath(profile));
    expect(started.status).toBe(201);
    const { checkout } = started.body;
    const handles = checkout.messages.map((m: any) => m.handle);
    await browser.post(`/api/checkouts/${checkout.id}/decisions`, { handles, decision: { kind: 'discard', reason: 'bad payload' } });
    expect((await applyAndWait(browser, `/api/checkouts/${checkout.id}/apply`, { confirm: true })).status).toBe(202);
    return (await browser.get(`/api/audit-entries?checkoutId=${checkout.id}`)).body.entries as any[];
  }

  beforeAll(async () => {
    const port = await closedPort();
    baseUrl = `http://127.0.0.1:${port}`;
    const nowhere = await closedPort();
    app = await startApp({
      profiles: [
        testProfile({ name: 'prod', roles: { viewer: ['support'], operator: ['oncall'], admin: ['platform'] } }),
        testProfile({ name: 'dev' }),
        // A broker nobody can reach: a role error here is answered before any broker call.
        testProfile({
          name: 'offline',
          managementUrl: `http://127.0.0.1:${nowhere}`,
          amqpUrl: `amqp://127.0.0.1:${nowhere}`,
          roles: { viewer: ['support'], admin: ['platform'] },
        }),
      ],
      port,
      env: teamModeEnv(baseUrl),
    });
    await seedMessages('/', queue, 1);
    [prodDiscard] = await discardAll(await signedIn(otto), 'prod');
  });
  afterEach(async () => {
    await purgeQueues('/', [queue]);
  });
  afterAll(async () => {
    await app?.close();
  });

  describe('the profile list and the session', () => {
    it.each([
      ['a viewer', vera, ['prod', 'dev', 'offline'], { prod: 'viewer', dev: 'admin', offline: 'viewer' }],
      ['an `operator`', otto, ['prod', 'dev'], { prod: 'operator', dev: 'admin' }],
      ['an `admin`', ada, ['prod', 'dev', 'offline'], { prod: 'admin', dev: 'admin', offline: 'admin' }],
      ['an Operator in no mapped group', nora, ['dev'], { dev: 'admin' }],
      ['an Operator without a groups claim', ned, ['dev'], { dev: 'admin' }],
    ])('lists for %s only the profiles where they have a role', async (_who, identity, profiles, roles) => {
      const browser = await signedIn(identity);
      expect((await browser.get('/api/profiles')).body.profiles.map((p: any) => p.name)).toEqual(profiles);
      const session = (await browser.get('/api/session')).body;
      expect(session.roles).toEqual(roles);
      expect(session.groups).toEqual('groups' in identity ? identity.groups : []);
    });

    it('gives an Operator in several mapped groups the highest of their roles', async () => {
      const browser = await signedIn(bea);
      expect((await browser.get('/api/session')).body.roles).toEqual({ prod: 'admin', dev: 'admin', offline: 'admin' });
    });

    it('applies a role change at the next sign-in', async () => {
      const browser = await signedIn(nora);
      expect((await browser.get('/api/session')).body.roles.prod).toBeUndefined();
      await browser.signIn({ ...nora, groups: ['oncall'] });
      expect((await browser.get('/api/session')).body.roles.prod).toBe('operator');
    });
  });

  describe('no role on a profile', () => {
    it.each<[string, string, unknown?]>([
      ['GET', '/api/profiles/prod/vhosts'],
      ['GET', queuesPath('prod')],
      ['GET', '/api/profiles/prod/vhosts/%2F/move-destinations'],
      ['GET', '/api/profiles/prod/vhosts/%2F/dead-letter-map'],
      ['POST', checkoutPath('prod'), {}],
    ])('answers %s %s with 403 no_role_on_profile', async (method, path, body) => {
      const browser = await signedIn(nora);
      const res = await browser.request(method, path, body === undefined ? {} : { body });
      expect(res.status).toBe(403);
      expect(res.body.error).toMatchObject({ code: 'no_role_on_profile', profile: 'prod' });
    });

    it('answers before any broker call', async () => {
      const browser = await signedIn(nora);
      for (const path of ['/api/profiles/offline/vhosts', queuesPath('offline')]) {
        expect((await browser.get(path)).body.error.code).toBe('no_role_on_profile');
      }
      expect((await browser.post(checkoutPath('offline'))).body.error.code).toBe('no_role_on_profile');
    });

    it("refuses the profile's Audit Entries, and leaves them out of the search", async () => {
      const browser = await signedIn(nora);
      const read = await browser.get(`/api/audit-entries/${prodDiscard.id}`);
      expect(read.status).toBe(403);
      expect(read.body.error.code).toBe('no_role_on_profile');
      const restore = await browser.post(`/api/audit-entries/${prodDiscard.id}/restore`, { confirm: true, confirmQueueName: queue });
      expect(restore.body.error.code).toBe('no_role_on_profile');

      expect((await browser.get('/api/audit-entries')).body.entries.map((e: any) => e.profile)).not.toContain('prod');
      expect((await browser.get('/api/audit-entries?profile=prod')).body.entries).toEqual([]);
    });
  });

  describe('a viewer', () => {
    it('sees the profile, its vhosts and its queue list', async () => {
      const browser = await signedIn(vera);
      expect((await browser.get('/api/profiles/prod/vhosts')).status).toBe(200);
      expect((await browser.get(queuesPath('prod'))).status).toBe(200);
    });

    it('searches and reads Audit Entries, but never receives a Discarded body', async () => {
      const browser = await signedIn(vera);
      const found = (await browser.get('/api/audit-entries?profile=prod')).body.entries;
      expect(found.map((e: any) => e.id)).toContain(prodDiscard.id);
      const read = await browser.get(`/api/audit-entries/${prodDiscard.id}`);
      expect(read.status).toBe(200);
      expect(read.body.entry.message).not.toHaveProperty('body');
      expect(JSON.stringify(read.body)).not.toContain(Buffer.from('{"n":0}').toString('base64'));
    });

    it.each<[string, string, unknown?]>([
      ['POST', checkoutPath('prod'), {}],
      ['GET', '/api/profiles/prod/vhosts/%2F/move-destinations'],
    ])('is refused %s %s with 403 role_required', async (method, path, body) => {
      await seedMessages('/', queue, 1);
      const browser = await signedIn(vera);
      const res = await browser.request(method, path, body === undefined ? {} : { body });
      expect(res.status).toBe(403);
      expect(res.body.error).toMatchObject({ code: 'role_required', profile: 'prod', required: 'operator', held: 'viewer' });
      expect(await readyCount('/', queue)).toBe(1);
    });

    it('is refused a Restore with 403 role_required', async () => {
      const res = await (await signedIn(vera)).post(`/api/audit-entries/${prodDiscard.id}/restore`, { confirm: true, confirmQueueName: queue });
      expect(res.status).toBe(403);
      expect(res.body.error).toMatchObject({ code: 'role_required', required: 'admin', held: 'viewer' });
    });

    it('is refused before any broker call', async () => {
      const res = await (await signedIn(vera)).post(checkoutPath('offline'));
      expect(res.body.error).toMatchObject({ code: 'role_required', required: 'operator', held: 'viewer' });
    });

    it('cannot use a Checkout started under a higher role, once signed in again as a viewer', async () => {
      await seedMessages('/', queue, 1);
      const browser = await signedIn({ ...otto, groups: ['oncall'] });
      const started = await browser.post(checkoutPath('prod'));
      expect(started.status).toBe(201);
      const id = started.body.checkout.id;
      const handle = started.body.checkout.messages[0].handle;

      await browser.signIn({ ...otto, groups: ['support'] });
      for (const [method, path, body] of [
        ['GET', `/api/checkouts/${id}`],
        ['GET', `/api/checkouts/${id}/messages/${handle}`],
        ['GET', `/api/checkouts/${id}/compare?a=${handle}&b=${handle}`],
        ['POST', `/api/checkouts/${id}/matching`, { filter: [] }],
        ['POST', `/api/checkouts/${id}/decisions`, { handles: [handle], decision: { kind: 'discard', reason: 'x' } }],
        ['POST', `/api/checkouts/${id}/apply`, { confirm: true, confirmQueueName: queue }],
        ['POST', `/api/checkouts/${id}/export`, {}],
      ] as Array<[string, string, unknown?]>) {
        const res = await browser.request(method, path, body === undefined ? {} : { body });
        expect(res.status, `${method} ${path}`).toBe(403);
        expect(res.body.error).toMatchObject({ code: 'role_required', required: 'operator', held: 'viewer' });
      }

      await browser.signIn({ ...otto, groups: ['oncall'] });
      expect((await browser.request('DELETE', `/api/checkouts/${id}`)).status).toBe(200);
      expect(await readyCount('/', queue)).toBe(1);
    });
  });

  describe('an `operator`', () => {
    it('reads Discarded bodies', async () => {
      const read = await (await signedIn(otto)).get(`/api/audit-entries/${prodDiscard.id}`);
      expect(read.body.entry.message.body).toBe(Buffer.from('{"n":0}').toString('base64'));
    });

    it('starts a Checkout, assigns Decisions and Applies, and the Audit Entry records the role', async () => {
      await seedMessages('/', queue, 1);
      const [entry] = await discardAll(await signedIn(otto), 'prod');
      expect(entry).toMatchObject({ operatorId: otto.sub, action: 'discard', outcome: 'done', role: 'operator' });
      expect(await readyCount('/', queue)).toBe(0);
    });

    it('is refused a Restore with 403 role_required', async () => {
      const res = await (await signedIn(otto)).post(`/api/audit-entries/${prodDiscard.id}/restore`, { confirm: true, confirmQueueName: queue });
      expect(res.status).toBe(403);
      expect(res.body.error).toMatchObject({ code: 'role_required', required: 'admin', held: 'operator' });
      expect(await readyCount('/', queue)).toBe(0);
    });
  });

  describe('an `admin`', () => {
    it('Restores, and the Restore records the role', async () => {
      await seedMessages('/', queue, 1);
      const [discarded] = await discardAll(await signedIn(ada), 'prod');
      expect(discarded.role).toBe('admin');
      const res = await (await signedIn(ada)).post(`/api/audit-entries/${discarded.id}/restore`, { confirm: true });
      expect(res.status).toBe(200);
      expect(res.body.entry).toMatchObject({ action: 'restore', outcome: 'done', role: 'admin' });
      expect(await readyCount('/', queue)).toBe(1);
    });
  });

  describe('a profile without roles', () => {
    it('lets every signed-in Operator do everything, as in v0.2', async () => {
      await seedMessages('/', queue, 1);
      const browser = await signedIn(nora);
      const [discarded] = await discardAll(browser, 'dev');
      expect(discarded).toMatchObject({ profile: 'dev', outcome: 'done', role: 'admin' });
      expect((await browser.get(`/api/audit-entries/${discarded.id}`)).body.entry.message.body).toBeTruthy();
      const restored = await browser.post(`/api/audit-entries/${discarded.id}/restore`, { confirm: true });
      expect(restored.status).toBe(200);
      expect(await readyCount('/', queue)).toBe(1);
    });
  });

  it('limits the Audit Entry search to the entries the Operator may read', async () => {
    await seedMessages('/', queue, 1);
    const [devEntry] = await discardAll(await signedIn(nora), 'dev');
    await seedMessages('/', queue, 1);
    await discardAll(await signedIn(otto), 'prod');
    // The newest entry is on prod: `limit` still finds nora's.
    const found = (await (await signedIn(nora)).get('/api/audit-entries?limit=1')).body.entries;
    expect(found.map((e: any) => e.id)).toEqual([devEntry.id]);
  });
});

describe('Audit Entries of a Broker Profile the Operator has no role on, or no longer configured', () => {
  let app: TestApp;
  let baseUrl: string;
  let dataDir: string;
  let retired: number;
  let secretReplay: number;
  const body = Buffer.from('{"card":"4111"}');

  beforeAll(async () => {
    dataDir = await makeTempDir('roles-retired');
    const store = new AuditStore(dataDir);
    const recorded = (profile: string, action: 'discard' | 'replay', replayId: string | null) =>
      store.record({
        at: new Date(),
        operator: { id: 'someone', displayName: 'someone' },
        brokerUser: 'volveran-admin',
        profile,
        vhost: '/',
        queue,
        messageId: 'm-1',
        action,
        reason: action === 'discard' ? 'bad payload' : null,
        destination: null,
        checkoutId: 'c',
        message: { body, properties: { messageId: 'm-1' }, headers: {} },
        replayId,
      });
    retired = recorded('retired', 'discard', null);
    secretReplay = recorded('secret', 'replay', 'r-secret');
    store.close();
    const port = await closedPort();
    baseUrl = `http://127.0.0.1:${port}`;
    const nowhere = await closedPort();
    // Every configured profile has roles: an Operator in no mapped group has no role anywhere.
    app = await startApp({
      profiles: [
        testProfile({ name: 'prod', roles: { viewer: ['support'], operator: ['oncall', 'platform'] } }),
        testProfile({
          name: 'secret',
          managementUrl: `http://127.0.0.1:${nowhere}`,
          amqpUrl: `amqp://127.0.0.1:${nowhere}`,
          roles: { admin: ['platform'] },
        }),
      ],
      port,
      env: teamModeEnv(baseUrl),
      dataDir,
    });
  });
  afterEach(async () => {
    await purgeQueues('/', [queue]);
  });
  afterAll(async () => {
    await app?.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  async function signedIn(identity: TestIdentity) {
    const browser = new TestBrowser(baseUrl);
    await browser.signIn(identity);
    return browser;
  }

  it('gives the Operator the highest role they hold on any configured profile', async () => {
    const viewer = await signedIn(vera);
    const read = await viewer.get(`/api/audit-entries/${retired}`);
    expect(read.status).toBe(200);
    expect(read.body.entry.message).not.toHaveProperty('body');
    expect((await viewer.get('/api/audit-entries?profile=retired')).body.entries.map((e: any) => e.id)).toEqual([retired]);

    const operator = await signedIn(otto);
    expect((await operator.get(`/api/audit-entries/${retired}`)).body.entry.message.body).toBe(body.toString('base64'));
    const restore = await operator.post(`/api/audit-entries/${retired}/restore`, { confirm: true });
    expect(restore.body.error).toMatchObject({ code: 'role_required', profile: 'retired', required: 'admin', held: 'operator' });
  });

  it('withholds them from an Operator with no role anywhere', async () => {
    const browser = await signedIn(nora);
    const read = await browser.get(`/api/audit-entries/${retired}`);
    expect(read.status).toBe(403);
    expect(read.body.error).toMatchObject({ code: 'no_role_on_profile', profile: 'retired' });
    expect((await browser.get('/api/audit-entries')).body.entries).toEqual([]);
    expect((await browser.get('/api/audit-entries?profile=retired')).body.entries).toEqual([]);
  });

  it("refuses the audit store's usage to an Operator with no role anywhere", async () => {
    const refused = await (await signedIn(nora)).get('/api/audit-store');
    expect(refused.status).toBe(403);
    expect(refused.body.error.code).toBe('no_role');
    expect((await (await signedIn(vera)).get('/api/audit-store')).status).toBe(200);
  });

  it('flags a Died Again Message without the Audit Entry that sent it out when the Operator has no role on its profile', async () => {
    await withChannel('/', async (ch) => {
      ch.sendToQueue(queue, Buffer.from('again'), { messageId: 'm-1', headers: { 'x-volveran-replay-id': 'r-secret' } });
      await ch.waitForConfirms();
    });
    for (const [identity, last] of [
      [otto, null],
      [ada, expect.objectContaining({ auditEntryId: secretReplay })],
    ] as const) {
      const browser = await signedIn(identity);
      const started = await browser.post(checkoutPath('prod'));
      expect(started.status).toBe(201);
      const { checkout } = started.body;
      expect(checkout.messages[0].diedAgain).toEqual({ replayId: 'r-secret', count: 1, last });
      expect((await browser.request('DELETE', `/api/checkouts/${checkout.id}`)).status).toBe(200);
    }
  });
});

describe('Roles in Solo Mode', () => {
  let app: TestApp;
  beforeAll(async () => {
    app = await startApp({
      profiles: [testProfile({ name: 'prod', roles: { viewer: ['support'] } })],
    });
  });
  afterEach(async () => {
    await purgeQueues('/', [queue]);
  });
  afterAll(async () => {
    await app?.close();
  });

  it('ignores `roles`: the Operator is `admin` everywhere', async () => {
    expect((await app.get('/api/session')).body).toEqual({ mode: 'solo', operator: testOperator, checkoutId: null, roles: { prod: 'admin' } });
    await seedMessages('/', queue, 1);
    const started = await app.post(checkoutPath('prod'));
    expect(started.status).toBe(201);
    const { checkout } = started.body;
    await app.post(`/api/checkouts/${checkout.id}/decisions`, { handles: [checkout.messages[0].handle], decision: { kind: 'discard', reason: 'x' } });
    expect((await applyAndWait(app, `/api/checkouts/${checkout.id}/apply`, { confirm: true })).status).toBe(202);
    const [entry] = (await app.get(`/api/audit-entries?checkoutId=${checkout.id}`)).body.entries;
    expect(entry.role).toBe('admin');
    expect((await app.post(`/api/audit-entries/${entry.id}/restore`, { confirm: true })).status).toBe(200);
  });
});
