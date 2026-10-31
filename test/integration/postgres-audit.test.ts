// Setting the connection URL makes PostgreSQL the audit store: an Operator Applies
// and finds the Audit Entries in the Audit view, also after a restart.
import { readdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AUDIT_DB_FILE } from '../../src/server/audit/sqlite-audit-store.js';
import { ConfigError } from '../../src/server/config-error.js';
import { createTestDatabase, type TestDatabase } from '../support/test-postgres.js';
import { applyAndWait, deadLetter, deadLetterRoutes, fixtureQueues, makeTempDir, purgeQueues, readyMessageIds, startApp, testOperator, testProfile, type TestApp } from './harness.js';

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
