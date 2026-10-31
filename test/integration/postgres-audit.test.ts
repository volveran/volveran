// Setting the connection URL makes PostgreSQL the audit store: an Operator Applies
// and finds the Audit Entries in the Audit view, also after a restart, and Replay
// Rules, depth history and Alerts keep what they need there.
import { readdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AUDIT_DB_FILE } from '../../src/server/audit/sqlite-audit-store.js';
import { ConfigError } from '../../src/server/config-error.js';
import { createTestDatabase, type TestDatabase } from '../support/test-postgres.js';
import { startFakeDestination, type FakeDestination } from './fake-destination.js';
import {
  applyAndWait,
  deadLetter,
  deadLetterRoutes,
  eventually,
  fixtureQueues,
  makeTempDir,
  purgeQueues,
  readyMessageIds,
  ruleSchedulerHooks,
  samplerHooks,
  startApp,
  testOperator,
  testProfile,
  type TestApp,
} from './harness.js';

const QUEUE = 'orders.dlq';
const checkoutPath = `/api/profiles/local/vhosts/%2F/queues/${encodeURIComponent(QUEUE)}/checkouts`;

describe('the audit store on PostgreSQL', () => {
  let database: TestDatabase;
  let app: TestApp | undefined;
  let dataDir: string;

  const start = () => startApp({ profiles: [testProfile({ name: 'local' })], dataDir, env: { VOLVERAN_POSTGRES_URL: database.url } });

  beforeEach(async () => {
    database = await createTestDatabase();
    dataDir = await makeTempDir('postgres-audit');
    await purgeQueues('/', fixtureQueues);
  });
  afterEach(async () => {
    await app?.close();
    app = undefined;
    await database.drop();
    await rm(dataDir, { recursive: true, force: true });
    await purgeQueues('/', fixtureQueues);
  });

  it('records an Apply of a Keep and a Replay, shows it in the Audit view, and still does after a restart', async () => {
    app = await start();
    await deadLetter(deadLetterRoutes.classic, [
      { body: 'kept', options: { messageId: 'kept' } },
      { body: 'replayed', options: { messageId: 'replayed' } },
    ]);

    const { body } = await app.post(checkoutPath);
    const { id, messages } = body.checkout;
    const handle = (messageId: string) => messages.find((m: any) => m.messageId === messageId).handle;
    await app.post(`/api/checkouts/${id}/decisions`, { handles: [handle('kept')], decision: { kind: 'keep' } });
    const decided = await app.post(`/api/checkouts/${id}/decisions`, { handles: [handle('replayed')], decision: { kind: 'replay' } });
    expect(decided.status).toBe(200);
    expect((await applyAndWait(app, `/api/checkouts/${id}/apply`, { confirm: true })).status).toBe(202);

    expect(await readyMessageIds('/', QUEUE)).toEqual(['kept']);
    const expected = { action: 'replay', messageId: 'replayed', queue: QUEUE, profile: 'local', operatorName: testOperator, outcome: 'done', checkoutId: id };

    const { entries } = (await app.get(`/api/audit-entries?checkoutId=${id}`)).body;
    expect(entries).toEqual([expect.objectContaining(expected)]);
    expect((await app.get(`/api/audit-entries/${entries[0].id}`)).body.entry).toMatchObject(expected);

    await app.close();
    app = await start();
    expect((await app.get(`/api/audit-entries?checkoutId=${id}`)).body.entries).toEqual([expect.objectContaining(expected)]);
  });

  it('keeps nothing in the data directory', async () => {
    app = await start();
    expect(await readdir(dataDir)).toEqual([]);
  });

  it('refuses to start on a store newer than this version', async () => {
    app = await start();
    await app.close();
    app = undefined;
    await database.query('UPDATE audit_store_version SET version = 100000');

    await expect(start()).rejects.toBeInstanceOf(ConfigError);
  });

  it('refuses a URL that is not PostgreSQL, without repeating it', async () => {
    const refused = startApp({ profiles: [testProfile({ name: 'local' })], env: { VOLVERAN_POSTGRES_URL: 'mysql://user:secret@host/db' } });
    await expect(refused).rejects.toBeInstanceOf(ConfigError);
    await expect(refused).rejects.not.toThrow(/secret/);
  });
});

describe('Replay Rules, depth history and Alerts on PostgreSQL', () => {
  const route = deadLetterRoutes.classic;
  const dlq = route.dlq;
  const MINUTE = 60_000;
  const replayRule = {
    name: 'retry',
    vhost: '/',
    queue: dlq,
    every: '5m',
    backoff: { initial: '10m', multiplier: 1, max: '10m' },
    maxAttempts: 10,
    stopWhen: { diedAgain: 3, within: '1h' },
  };
  const alertRule = { name: 'deep', destinations: ['pager'], when: { vhost: '/', queue: dlq, depthAbove: 0 } };
  const one = [{ body: 'one', options: { messageId: 'one' } }];

  let database: TestDatabase;
  let destination: FakeDestination;
  let app: TestApp | undefined;

  const start = (profile: Record<string, unknown>, hooks: Record<string, unknown> = {}) =>
    startApp({
      profiles: [testProfile({ name: 'local', ...profile })],
      alertDestinations: [{ name: 'pager', type: 'webhook', urlEnv: 'HOOK_URL' }],
      env: { VOLVERAN_POSTGRES_URL: database.url, HOOK_URL: destination.url },
      ...hooks,
    });
  const restart = async (profile: Record<string, unknown>, hooks: Record<string, unknown> = {}) => {
    await app!.close();
    app = await start(profile, hooks);
  };
  const waitForDepth = (depth: number) =>
    eventually(async () => {
      const { body } = await app!.get('/api/profiles/local/vhosts/%2F/queues');
      expect(body.queues.find((q: any) => q.name === dlq)?.approximateMessages).toBe(depth);
    }, 30_000, 250);
  const listed = async () => (await app!.get('/api/profiles/local/replay-rules')).body.rules[0];

  beforeAll(async () => {
    destination = await startFakeDestination();
  });
  afterAll(() => destination.close());
  beforeEach(async () => {
    database = await createTestDatabase();
    destination.received.length = 0;
    await purgeQueues('/', fixtureQueues);
  });
  afterEach(async () => {
    await app?.close();
    app = undefined;
    await database.drop();
    await purgeQueues('/', fixtureQueues);
  });

  it('keeps a Replay Rule paused across a restart, and running once resumed, with its passes and what it saw', async () => {
    const scheduler = ruleSchedulerHooks();
    const profile = { replayRules: [replayRule] };
    const hooks = { checkoutTestHooks: scheduler.hooks };
    app = await start(profile, hooks);
    expect((await listed()).state.paused).toBe(false);

    await deadLetter(route, one);
    expect(await scheduler.runPass('local', 'retry')).toMatchObject({ status: 'ran', summary: { held: 1 } });

    expect((await app.post('/api/profiles/local/replay-rules/retry/pause', { reason: 'payments incident' })).status).toBe(200);
    await restart(profile, hooks);
    expect((await listed()).state).toMatchObject({ paused: true, pausedReason: 'payments incident', pausedBy: testOperator });

    expect((await app.post('/api/profiles/local/replay-rules/retry/resume')).status).toBe(200);
    await restart(profile, hooks);
    const resumed = await listed();
    expect(resumed.state).toMatchObject({ paused: false, pausedReason: null });
    expect(resumed.passes).toEqual([expect.objectContaining({ status: 'ran' })]);

    // The badge of a held Message, read from what the pass stored.
    const { body } = await app.post(`/api/profiles/local/vhosts/%2F/queues/${encodeURIComponent(dlq)}/checkouts`);
    expect(body.checkout.messages.map((m: any) => m.rule?.name)).toEqual(['retry']);
  });

  it('shows Samples from PostgreSQL in the history view, also after a restart', async () => {
    const sampler = samplerHooks();
    app = await start({}, { samplerTestHooks: sampler.hooks });
    await deadLetter(route, one);
    await waitForDepth(1);
    await sampler.sampleNow();

    const range = `?from=${new Date(Date.now() - MINUTE).toISOString()}&to=${new Date(Date.now() + MINUTE).toISOString()}`;
    const historyPath = `/api/profiles/local/vhosts/%2F/queues/${encodeURIComponent(dlq)}/history${range}`;
    const expectOneSample = async () => {
      const { status, body } = await app!.get(historyPath);
      expect(status).toBe(200);
      expect(body.samples.map((s: any) => s.depth)).toEqual([1]);
    };
    await expectOneSample();

    await restart({}, { samplerTestHooks: samplerHooks().hooks });
    await expectOneSample();
  });

  it('fires an Alert, keeps it firing without sending again across a restart, and resolves it', async () => {
    const profile = { alerts: [alertRule] };
    let sampler = samplerHooks();
    app = await start(profile, { samplerTestHooks: sampler.hooks });
    await deadLetter(route, one);
    await waitForDepth(1);
    await sampler.sampleNow();
    await eventually(async () => expect(destination.received).toHaveLength(1), 10_000, 50);
    const fired = destination.received[0]!.json as { status: string; alertId: string };
    expect(fired.status).toBe('firing');

    sampler = samplerHooks(new Date(Date.now() + MINUTE));
    await restart(profile, { samplerTestHooks: sampler.hooks });
    await sampler.sampleNow();
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(destination.received).toHaveLength(1);
    expect((await app!.get('/api/alerts')).body.alerts).toEqual([expect.objectContaining({ alertId: fired.alertId, status: 'firing' })]);

    await purgeQueues('/', [dlq]);
    await waitForDepth(0);
    sampler.set(new Date(sampler.now().getTime() + MINUTE));
    await sampler.sampleNow();
    sampler.set(new Date(sampler.now().getTime() + MINUTE));
    await sampler.sampleNow();
    await eventually(async () => expect(destination.received).toHaveLength(2), 10_000, 50);
    expect(destination.received[1]!.json).toMatchObject({ status: 'resolved', alertId: fired.alertId });
    expect((await app!.get('/api/alerts')).body.notifications.map((n: any) => n.status)).toEqual(['resolved', 'firing']);
  });
});

describe('the audit store on SQLite', () => {
  it('refuses to start on a store newer than this version', async () => {
    const dataDir = await makeTempDir('sqlite-newer');
    const app = await startApp({ profiles: [testProfile({ name: 'local' })], dataDir });
    await app.close();
    const db = new DatabaseSync(path.join(dataDir, AUDIT_DB_FILE));
    db.exec('PRAGMA user_version = 100000');
    db.close();

    await expect(startApp({ profiles: [testProfile({ name: 'local' })], dataDir })).rejects.toBeInstanceOf(ConfigError);
    await rm(dataDir, { recursive: true, force: true });
  });
});
