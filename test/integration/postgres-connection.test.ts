// The connection to PostgreSQL itself: what a call on a silent database costs, and
// what makes a commit durable (ADR 0001, ADR 0013).
import { afterEach, describe, expect, it } from 'vitest';
import type pg from 'pg';
import { createPool, transaction } from '../../src/server/audit/postgres-connection.js';
import { createTestDatabase, type TestDatabase } from '../support/test-postgres.js';
import { startTcpProxy, type TcpProxy } from '../support/tcp-proxy.js';

describe('the connection to PostgreSQL', () => {
  let database: TestDatabase | undefined;
  let proxy: TcpProxy | undefined;
  let pool: pg.Pool | undefined;

  afterEach(async () => {
    await proxy?.close();
    await pool?.end();
    await database?.drop();
    proxy = pool = database = undefined;
  });

  it('gives up on a transaction after one query timeout on a silent database', async () => {
    database = await createTestDatabase();
    const url = new URL(database.url);
    proxy = await startTcpProxy(Number(url.port));
    url.port = String(proxy.port);
    const queryTimeoutMs = 1_000;
    pool = createPool(url.href, { queryTimeoutMs });
    await pool.query('SELECT 1');
    proxy.silence();

    const startedAt = Date.now();
    await expect(transaction(pool, (client) => client.query('SELECT 1'))).rejects.toThrow();

    // A ROLLBACK on the same silent connection would take a second timeout.
    expect(Date.now() - startedAt).toBeLessThan(2 * queryTimeoutMs);
  });
});
