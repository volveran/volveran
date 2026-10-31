// The audit store contract on a real PostgreSQL, with a database per test. The parts
// not switched on here are not on PostgreSQL yet; they show as skipped.
import { PostgresAuditStore } from '../../src/server/audit/postgres-audit-store.js';
import { auditStoreContract } from '../support/audit-store-contract.js';
import { createTestDatabase } from '../support/test-postgres.js';

auditStoreContract(
  'PostgreSQL',
  async () => {
    const database = await createTestDatabase();
    return {
      store: await PostgresAuditStore.open(database.url),
      reopen: () => PostgresAuditStore.open(database.url),
      makeNewer: async () => {
        await database.query('UPDATE audit_store_version SET version = 100000');
      },
      cleanup: () => database.drop(),
    };
  },
  ['Audit Entries', 'plain text', 'search', 'replay trail', 'retention', 'closing', 'a store newer than the binary'],
);
