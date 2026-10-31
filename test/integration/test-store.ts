// Which audit store the integration suite runs on: VOLVERAN_TEST_AUDIT_STORE, sqlite (the
// default) or postgres. As in production, the store follows from VOLVERAN_POSTGRES_URL, so
// on PostgreSQL each app gets a database of its own. An app given a `dataDir` is one a test
// restarts or seeds, so that directory stands for one database for the rest of the file.
import { createHash } from 'node:crypto';
import type { AuditStore } from '../../src/server/audit/audit-store.js';
import { PostgresAuditStore } from '../../src/server/audit/postgres-audit-store.js';
import { SqliteAuditStore } from '../../src/server/audit/sqlite-audit-store.js';
import { createTestDatabase, type TestDatabase } from '../support/test-postgres.js';

export function storeUnderTest(): 'sqlite' | 'postgres' {
  const store = process.env.VOLVERAN_TEST_AUDIT_STORE ?? 'sqlite';
  if (store !== 'sqlite' && store !== 'postgres') throw new Error(`VOLVERAN_TEST_AUDIT_STORE must be sqlite or postgres, got ${store}`);
  return store;
}

const databaseOfDir = new Map<string, Promise<TestDatabase>>();

function databaseFor(dataDir: string): Promise<TestDatabase> {
  const key = createHash('sha256').update(dataDir).digest('hex');
  let database = databaseOfDir.get(key);
  if (!database) {
    database = createTestDatabase();
    databaseOfDir.set(key, database);
  }
  return database;
}

/** What an app's environment needs for the store under test, and what to do once the app is gone. */
export async function storeEnv(dataDir?: string): Promise<{ env: Record<string, string>; release(): Promise<void> } | null> {
  if (storeUnderTest() === 'sqlite') return null;
  // A database kept for its directory goes with the test PostgreSQL's throwaway storage.
  if (dataDir) return { env: { VOLVERAN_POSTGRES_URL: (await databaseFor(dataDir)).url }, release: async () => {} };
  const database = await createTestDatabase();
  return { env: { VOLVERAN_POSTGRES_URL: database.url }, release: () => database.drop() };
}

/** The store an app started with `dataDir` uses, for a test to seed it or read it. */
export async function openTestStore(dataDir: string): Promise<AuditStore> {
  return storeUnderTest() === 'sqlite' ? new SqliteAuditStore(dataDir) : PostgresAuditStore.open((await databaseFor(dataDir)).url);
}
