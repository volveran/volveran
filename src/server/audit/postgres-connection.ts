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

// TEXT cannot hold NUL, which a message id or a queue's name can contain and SQLite keeps.
// So NUL is stored as U+0001 U+0001 and U+0001 as U+0001 U+0002. No two values store alike,
// so a search stays exact, and bytewise order holds as on SQLite, as both stand below every
// other character in the order they had. Any other value is stored as it is. This happens
// on the connection, so no statement can forget it: values going in here, TEXT columns
// coming back through `types`.
const fromStoredText = (text: string) => text.replace(/\u0001([\u0001\u0002])/g, (_, c: string) => (c === '\u0001' ? '\0' : '\u0001'));
const toStoredText = (text: string) => text.replace(/[\0\u0001]/g, (c) => (c === '\0' ? '\u0001\u0001' : '\u0001\u0002'));

/** A statement's value as it is stored: a string, or the strings of an array of them. */
const storable = (value: unknown): unknown => {
  if (typeof value === 'string') return toStoredText(value);
  return Array.isArray(value) ? value.map(storable) : value;
};

class StoreClient extends pg.Client {
  override query(...args: unknown[]): never {
    const [statement, values, ...rest] = args;
    const query = super.query as (...given: unknown[]) => never;
    return query.call(this, statement, Array.isArray(values) ? values.map(storable) : values, ...rest);
  }
}

export function createPool(connectionString: string): pg.Pool {
  const pool = new pg.Pool({ connectionString, max: MAX_CONNECTIONS, connectionTimeoutMillis: CONNECT_TIMEOUT_MS, types, Client: StoreClient });
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
