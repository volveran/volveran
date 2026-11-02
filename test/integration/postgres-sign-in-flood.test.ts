// N6 on a real PostgreSQL, under concurrent adds: a first query that fails under load once let
// the sign-ins in progress past their limit, which the contract suite, adding one at a time, passed.
import { afterEach, describe, expect, it } from 'vitest';
import { PostgresAuditStore } from '../../src/server/audit/postgres-audit-store.js';
import { createTestDatabase, type TestDatabase } from '../support/test-postgres.js';

const NOW = 1_000_000;
const KEEP = 200;

describe('sign-ins in progress on PostgreSQL', () => {
  let database: TestDatabase;
  afterEach(async () => {
    await database.drop();
  });

  it('stays at its limit under a flood, and no add fails', async () => {
    database = await createTestDatabase();
    const store = await PostgresAuditStore.open(database.url);
    try {
      for (let wave = 0; wave < 3; wave++) {
        await Promise.all(Array.from({ length: 300 }, (_, i) => store.sessions.addSignIn(`s-${wave}-${i}`, { sealed: 'x', expiresAt: NOW + 1_000 + wave * 1_000 + i }, NOW, KEEP)));
      }
      await store.sessions.addSignIn('last', { sealed: 'x', expiresAt: NOW + 100_000 }, NOW, KEEP);
      const { rows } = await database.query('SELECT count(*) FROM sign_ins');
      // One add sees its own row and not those being added beside it, so a small excess can wait for the next add.
      expect(Number(rows[0]!.count)).toBeLessThanOrEqual(KEEP + 32);
      expect(await store.sessions.takeSignIn('last', NOW)).toBe('x');
    } finally {
      await store.close();
    }
  }, 60_000);
});
