// The bounded connection pool of the audit store on PostgreSQL, and the one way to
// carry out a multi-statement call: on one pooled connection, in one transaction
// (ADR 0013).
import pg from 'pg';

const MAX_CONNECTIONS = 10;
const CONNECT_TIMEOUT_MS = 10_000;

// Timestamps, ids and every other integer are BIGINT, which the driver hands over as
// text by default. They are all well within a JavaScript number.
const types = {
  getTypeParser: ((oid: number, format?: 'text' | 'binary') => {
    if (oid === pg.types.builtins.INT8) return Number;
    if (oid === pg.types.builtins.TEXT) return fromStoredText;
    return pg.types.getTypeParser(oid, format as 'text');
  }) as typeof pg.types.getTypeParser,
};

// TEXT cannot hold NUL, which a Message's message-id or a queue's name can contain and
// SQLite keeps. So a NUL is stored as ESCAPE then '0', and ESCAPE itself as two of them:
// no two values store alike, so equality in a search still holds, and any other value is
// stored as it is. Every TEXT column reads back through fromStoredText (`types` above);
// whatever goes into or is compared with one goes through storableValues.
const ESCAPE = '\u2400'; // SYMBOL FOR NULL
const fromStoredText = (text: string) => text.replace(/\u2400([0\u2400])/g, (_, c: string) => (c === '0' ? '\0' : ESCAPE));
const toStoredText = (text: string) => text.replace(/[\0\u2400]/g, (c) => (c === '\0' ? `${ESCAPE}0` : ESCAPE + ESCAPE));

/** A statement's values, with each string as a TEXT column stores it. */
export function storableValues<T>(values: readonly T[]): T[] {
  return values.map((value) => (typeof value === 'string' ? (toStoredText(value) as T) : value));
}

export function createPool(connectionString: string): pg.Pool {
  const pool = new pg.Pool({ connectionString, max: MAX_CONNECTIONS, connectionTimeoutMillis: CONNECT_TIMEOUT_MS, types });
  // A connection lost while idle. The pool drops it and the next call makes a new one or
  // rejects; without a listener, the event would stop the process.
  pool.on('error', () => {});
  return pool;
}

/** Runs `work` in one transaction: committed when it resolves, rolled back when it rejects. */
export async function transaction<T>(pool: pg.Pool, work: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  let failure: Error | undefined;
  try {
    await client.query('BEGIN');
    const result = await work(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    failure = err as Error;
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    // A connection whose transaction failed is not trusted again.
    client.release(failure);
  }
}
