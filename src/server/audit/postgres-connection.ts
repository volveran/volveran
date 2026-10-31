// The bounded connection pool of the audit store on PostgreSQL, and the one way to
// carry out a multi-statement call: on one pooled connection, in one transaction
// (ADR 0013).
import pg from 'pg';
import { ConfigError } from '../config-error.js';

const MAX_CONNECTIONS = 10;
const CONNECT_TIMEOUT_MS = 10_000;
// A database that vanishes without a word never closes the connection. No statement of
// the store takes this long, so a call rejects rather than waiting for ever, and its
// connection is dropped. Connections are kept alive for the same reason.
const QUERY_TIMEOUT_MS = 30_000;

/** TLS to PostgreSQL: required, and the certificate verified against `ca` or else the system's CAs. */
export interface PostgresTls {
  /** PEM certificates (VOLVERAN_POSTGRES_CA_FILE). */
  ca?: string;
}

export interface PoolOptions {
  /** Null leaves TLS to the URL. */
  tls?: PostgresTls | null;
  /** Null lets a statement run as long as it takes, for migrations. */
  queryTimeoutMs?: number | null;
  max?: number;
}

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
  constructor(config?: string | pg.ClientConfig) {
    super(config);
    // A lost connection rejects its calls. The pool only listens while a connection is
    // idle; without a listener on one in use, the event would stop the process.
    this.on('error', () => {});
  }

  override query(...args: unknown[]): never {
    const [statement, values, ...rest] = args;
    const query = super.query as (...given: unknown[]) => never;
    return query.call(this, statement, Array.isArray(values) ? values.map(storable) : values, ...rest);
  }
}

export function createPool(connectionString: string, { tls, queryTimeoutMs = QUERY_TIMEOUT_MS, max = MAX_CONNECTIONS }: PoolOptions = {}): pg.Pool {
  const pool = new pg.Pool({
    connectionString,
    max,
    connectionTimeoutMillis: CONNECT_TIMEOUT_MS,
    query_timeout: queryTimeoutMs ?? undefined,
    keepAlive: true,
    types,
    Client: StoreClient,
    ...(tls && { ssl: { rejectUnauthorized: true, ca: tls.ca } }),
  });
  // A connection lost while idle. The pool drops it and the next call makes a new one or
  // rejects; without a listener, the event would stop the process.
  pool.on('error', () => {});
  return pool;
}

/** PostgreSQL's placeholder for the parameter at this position, from 1. */
export const numbered = (position: number) => `$${position}`;

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

const NETWORK_ERRORS = new Set(['ECONNREFUSED', 'ECONNRESET', 'EHOSTUNREACH', 'ENETUNREACH', 'ENOTFOUND', 'EAI_AGAIN', 'ETIMEDOUT', 'EPIPE']);

/** Why PostgreSQL could not be used, in words a platform engineer can act on, or null if `err` is about something else. */
function explain(err: Error & { code?: string }, connectionString: string): string | null {
  const url = new URL(connectionString);
  const at = `${url.hostname}:${url.port || 5432}`;
  const user = decodeURIComponent(url.username);
  const { code } = err;
  // A connection attempt to several addresses fails with an empty message.
  const detail = (err.message || code || 'unknown error').replaceAll(connectionString, '<url>');
  if (err instanceof pg.DatabaseError) {
    if (code?.startsWith('28')) return `PostgreSQL at ${at} refused the user "${user}": ${detail}. Check the user and password in VOLVERAN_POSTGRES_URL.`;
    if (code === '3D000') return `PostgreSQL at ${at} has no database "${decodeURIComponent(url.pathname.slice(1))}". Volverán never creates the database: create it, or correct VOLVERAN_POSTGRES_URL.`;
    if (code === '42501') return `The PostgreSQL user "${user}" lacks a permission Volverán needs: ${detail}. It must be able to create tables in the database (GRANT CREATE ON SCHEMA public) and to read and write them.`;
    return `PostgreSQL at ${at} refused: ${detail}`;
  }
  if (/\b(SSL|TLS)\b|CERT|certificate|UNABLE_TO_|ERR_TLS|ERR_SSL/.test(`${code ?? ''} ${detail}`)) {
    return `Could not make a TLS connection to PostgreSQL at ${at}: ${detail}. Check that the server offers TLS, and that VOLVERAN_POSTGRES_CA_FILE holds the CA of its certificate.`;
  }
  if ((code && NETWORK_ERRORS.has(code)) || /timeout|Connection terminated/i.test(detail)) {
    return `Could not reach PostgreSQL at ${at}: ${detail}. Check that it is running, and the host and port in VOLVERAN_POSTGRES_URL. Nothing is lost: start Volverán again when it is back.`;
  }
  if (code === 'ENOENT' || code === 'EACCES') return `Could not read a file VOLVERAN_POSTGRES_URL names: ${detail}.`;
  return null;
}

/** `err`, from startup work on an open store, as asStartupError when PostgreSQL refused it; otherwise `err`. */
export function refusalAsStartupError(err: unknown, connectionString: string): unknown {
  return err instanceof pg.DatabaseError ? asStartupError(err, connectionString) : err;
}

/** `err` as the clear startup error it should be, when it is about PostgreSQL; otherwise `err`. */
export function asStartupError(err: unknown, connectionString: string): unknown {
  if (err instanceof ConfigError || !(err instanceof Error)) return err;
  const reason = explain(err, connectionString);
  return reason === null ? err : new ConfigError(reason);
}
