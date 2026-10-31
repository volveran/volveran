// What only PostgreSQL has: its migrations under an advisory lock.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createPool } from '../../src/server/audit/postgres-connection.js';
import { migrate } from '../../src/server/audit/postgres-migrations.js';
import { PostgresAuditStore } from '../../src/server/audit/postgres-audit-store.js';
import { createTestDatabase, type TestDatabase } from '../support/test-postgres.js';

describe('PostgreSQL migrations', () => {
  let database: TestDatabase;
  beforeEach(async () => {
    database = await createTestDatabase();
  });
  afterEach(async () => {
    await database.drop();
  });

  const migrateWith = async (migrations: string[]) => {
    const pool = createPool(database.url);
    try {
      await migrate(pool, migrations);
    } finally {
      await pool.end();
    }
  };

  // Each writes a row: run twice, it leaves two. The wait keeps the others coming in meanwhile.
  const logged = (n: number) => `INSERT INTO applied (migration) VALUES (${n}); SELECT pg_sleep(0.1);`;
  const CREATE_LOG = 'CREATE TABLE applied (migration INTEGER NOT NULL);';

  it('applies each migration once when several start together', async () => {
    await Promise.all(Array.from({ length: 6 }, () => migrateWith([CREATE_LOG, logged(2), logged(3)])));

    const { rows } = await database.query('SELECT migration FROM applied ORDER BY migration');
    expect(rows.map((r) => r.migration)).toEqual([2, 3]);
    expect((await database.query('SELECT version FROM audit_store_version')).rows).toEqual([{ version: 3 }]);
  });

  it('opens one store from several starting together', async () => {
    const stores = await Promise.all(Array.from({ length: 4 }, () => PostgresAuditStore.open(database.url)));
    expect(await stores[0]!.list()).toEqual([]);
    await Promise.all(stores.map((s) => s.close()));
  });

  it('applies only what is new on a later start', async () => {
    await migrateWith([CREATE_LOG, logged(2)]);
    await migrateWith([CREATE_LOG, logged(2), logged(3)]);

    const { rows } = await database.query('SELECT migration FROM applied ORDER BY migration');
    expect(rows.map((r) => r.migration)).toEqual([2, 3]);
  });

  it('leaves no part of a migration that fails, and tries it again on the next start', async () => {
    await expect(migrateWith([CREATE_LOG, `INSERT INTO applied (migration) VALUES (2); SELECT nonsense FROM nowhere;`])).rejects.toThrow();
    expect((await database.query('SELECT migration FROM applied')).rows).toEqual([]);

    await migrateWith([CREATE_LOG, logged(2)]);
    expect((await database.query('SELECT migration FROM applied')).rows).toEqual([{ migration: 2 }]);
  });
});
