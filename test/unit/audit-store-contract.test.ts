// The audit store contract on SQLite, on disk as in production.
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { AUDIT_DB_FILE, SqliteAuditStore } from '../../src/server/audit/sqlite-audit-store.js';
import { auditStoreContract } from '../support/audit-store-contract.js';

auditStoreContract('SQLite', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'audit-contract-'));
  return {
    store: new SqliteAuditStore(dir),
    reopen: async () => new SqliteAuditStore(dir),
    makeNewer: async () => {
      const db = new DatabaseSync(path.join(dir, AUDIT_DB_FILE));
      db.exec('PRAGMA user_version = 100000');
      db.close();
    },
    cleanup: () => rm(dir, { recursive: true, force: true }),
  };
});
