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

  it('never asks a connection two things at once', async () => {
    const warnings: string[] = [];
    const listener = (warning: Error) => warnings.push(warning.message);
    process.on('warning', listener);
    try {
      database = await createTestDatabase();
      const opened = createPool(database.url);
      pool = opened;
      await Promise.all(Array.from({ length: 4 }, () => opened.query('SELECT 1')));
      await transaction(opened, (client) => client.query('SELECT 1'));
      // A warning is emitted on the next tick.
      await new Promise((resolve) => setTimeout(resolve, 50));
    } finally {
      process.off('warning', listener);
    }
    expect(warnings.filter((message) => message.includes('already executing'))).toEqual([]);
  });

  it('commits durably on every connection, whatever the database is set to', async () => {
    database = await createTestDatabase();
    await database.query(`ALTER DATABASE ${new URL(database.url).pathname.slice(1)} SET synchronous_commit = off`);
    pool = createPool(database.url);

    const clients = await Promise.all([pool.connect(), pool.connect()]);
    const answers = await Promise.all(clients.map((client) => client.query<{ synchronous_commit: string }>('SHOW synchronous_commit')));
    for (const client of clients) client.release();

    expect(answers.map(({ rows }) => rows[0]!.synchronous_commit)).toEqual(['on', 'on']);
  });
});
