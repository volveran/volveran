// `copy-audit-store`: copies a SQLite audit store into an empty PostgreSQL, while Volverán
// is stopped. Ids are kept, so links between entries and to a replay id stay as they are, and
// each identity sequence then continues after the highest id SQLite ever gave. All of it is
// one transaction, so a failure or a wrong row count leaves the target empty to try again.
// Tables and columns come from the two schemas, so a future table cannot be left behind.
// The source is only ever read: an older store is migrated in a temporary copy of it.
import { existsSync } from 'node:fs';
import { chmod, copyFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type pg from 'pg';
import { ConfigError } from '../config-error.js';
import { PostgresAuditStore } from './postgres-audit-store.js';
import { asStartupError, createPool, numbered, postgresAddress, transaction, type PostgresTls } from './postgres-connection.js';
import { parsePostgresUrl, readPostgresTls } from './postgres-url.js';
import { AUDIT_DB_FILE, SqliteAuditStore } from './sqlite-audit-store.js';

export interface CopyAuditStoreOptions {
  dataDir: string;
  postgresUrl: string;
  tls: PostgresTls | null;
}

export interface CopiedTable {
  table: string;
  rows: number;
}

// Below the protocol's 65,535 parameters at any table's width, and bounded in memory: a
// batch ends early once it holds this much, however few rows that is.
const BATCH_ROWS = 500;
const BATCH_BYTES = 32 * 1024 * 1024;

const quoted = (name: string) => `"${name.replaceAll('"', '""')}"`;

const rowBytes = (values: readonly unknown[]) =>
  values.reduce<number>((sum, value) => sum + (typeof value === 'string' ? value.length : value instanceof Uint8Array ? value.byteLength : 8), 0);

/**
 * Copies the store into `scratch`, with its write-ahead log so that nothing committed is missed,
 * and brings the copy up to this version's schema, as starting this version on it would.
 * Returns the copy's file. The shared-memory file is left out: SQLite rebuilds it from the log.
 */
async function migratedCopy(file: string, scratch: string): Promise<string> {
  const copied = path.join(scratch, AUDIT_DB_FILE);
  try {
    await copyFile(file, copied);
    await chmod(copied, 0o600);
    if (existsSync(`${file}-wal`)) {
      await copyFile(`${file}-wal`, `${copied}-wal`);
      await chmod(`${copied}-wal`, 0o600);
    }
  } catch (err) {
    throw new ConfigError(`Could not copy the SQLite audit store at ${file} to ${scratch}: ${(err as Error).message}`);
  }
  try {
    await new SqliteAuditStore(scratch).close();
  } catch (err) {
    if (err instanceof ConfigError) throw err;
    throw new ConfigError(`Could not read the SQLite audit store at ${file}: ${(err as Error).message}`);
  }
  return copied;
}

/** The source's tables and each one's columns; `audit_entries` first, as other tables refer to it. */
function sourceTables(source: DatabaseSync): Map<string, { columns: string[]; key: string[] }> {
  const names = source.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name <> 'audit_entries', name`).all() as { name: string }[];
  return new Map(
    names.map(({ name }) => {
      const info = source.prepare(`SELECT name, pk FROM pragma_table_info(?) ORDER BY cid`).all(name) as { name: string; pk: number }[];
      const key = info.filter((c) => c.pk > 0).sort((a, b) => a.pk - b.pk).map((c) => c.name);
      return [name, { columns: info.map((c) => c.name), key }];
    }),
  );
}

async function refuseOtherSchema(client: pg.PoolClient, tables: ReadonlyMap<string, { columns: string[] }>): Promise<void> {
  const { rows } = await client.query<{ table_name: string; column_name: string }>('SELECT table_name, column_name FROM information_schema.columns WHERE table_schema = current_schema()');
  const held = (table: string) => rows.filter((r) => r.table_name === table).map((r) => r.column_name).sort();
  for (const [table, { columns }] of tables) {
    if (held(table).join() !== [...columns].sort().join()) {
      throw new ConfigError(`The table ${table} of the SQLite audit store does not match its PostgreSQL schema, so it cannot be copied whole. Nothing was copied.`);
    }
  }
}

async function refuseNonEmpty(client: pg.PoolClient, tables: Iterable<string>, at: string): Promise<void> {
  const holding: string[] = [];
  for (const table of tables) {
    const { rows } = await client.query(`SELECT 1 FROM ${quoted(table)} LIMIT 1`);
    if (rows.length > 0) holding.push(table);
  }
  if (holding.length > 0) throw new ConfigError(`The PostgreSQL database at ${at} is not empty: ${holding.join(', ')} hold rows. Nothing was copied. Copy into a new database, so that two audit trails cannot be merged by accident.`);
}

async function copyRows(source: DatabaseSync, client: pg.PoolClient, table: string, { columns, key }: { columns: string[]; key: string[] }): Promise<void> {
  const insertInto = `INSERT INTO ${quoted(table)} (${columns.map(quoted).join(', ')}) VALUES `;
  const flush = async (batch: unknown[][]) => {
    if (batch.length === 0) return;
    const rows = batch.map((_, r) => `(${columns.map((_, c) => numbered(r * columns.length + c + 1)).join(', ')})`);
    await client.query(insertInto + rows.join(', '), batch.flat());
  };
  // In key order, so a Restore's entry follows the Discard it refers to.
  const select = source.prepare(`SELECT ${columns.map(quoted).join(', ')} FROM ${quoted(table)} ORDER BY ${key.map(quoted).join(', ')}`);
  let batch: unknown[][] = [];
  let bytes = 0;
  for (const row of select.iterate() as Iterable<Record<string, unknown>>) {
    const values = columns.map((column) => row[column]);
    batch.push(values);
    bytes += rowBytes(values);
    if (batch.length === BATCH_ROWS || bytes >= BATCH_BYTES) {
      await flush(batch);
      batch = [];
      bytes = 0;
    }
  }
  await flush(batch);
}

async function verifyCounts(source: DatabaseSync, client: pg.PoolClient, tables: Iterable<string>): Promise<CopiedTable[]> {
  const copied: CopiedTable[] = [];
  for (const table of tables) {
    const { n } = source.prepare(`SELECT count(*) AS n FROM ${quoted(table)}`).get() as { n: number };
    const { rows } = await client.query<{ n: number }>(`SELECT count(*) AS n FROM ${quoted(table)}`);
    if (rows[0]!.n !== n) throw new ConfigError(`The row counts of ${table} differ: ${n} in SQLite, ${rows[0]!.n} in PostgreSQL. Nothing was copied.`);
    copied.push({ table, rows: n });
  }
  return copied;
}

/**
 * Each identity continues after the highest id SQLite ever gave, which AUTOINCREMENT
 * remembers: rows retention removed may be higher than any left, and must not be reused.
 */
async function continueIds(source: DatabaseSync, client: pg.PoolClient): Promise<void> {
  const { rows } = await client.query<{ table_name: string; column_name: string }>(`SELECT table_name, column_name FROM information_schema.columns WHERE table_schema = current_schema() AND is_identity = 'YES'`);
  const given = source.prepare('SELECT seq FROM sqlite_sequence WHERE name = ?');
  for (const { table_name: table, column_name: column } of rows) {
    const { highest } = source.prepare(`SELECT COALESCE(MAX(${quoted(column)}), 0) AS highest FROM ${quoted(table)}`).get() as { highest: number };
    const last = Math.max(highest, Number((given.get(table) as { seq: number } | undefined)?.seq ?? 0));
    await client.query('SELECT setval(pg_get_serial_sequence($1, $2), $3, $4)', [quoted(table), column, Math.max(last, 1), last > 0]);
  }
}

/** Copies the SQLite store in `dataDir` into the database at `postgresUrl`, verifying row counts, or throws having changed nothing there but its empty schema. The source is left as it was. */
export async function copyAuditStore({ dataDir, postgresUrl, tls }: CopyAuditStoreOptions): Promise<CopiedTable[]> {
  const file = path.join(dataDir, AUDIT_DB_FILE);
  if (!existsSync(file)) throw new ConfigError(`No SQLite audit store at ${file}. Set VOLVERAN_DATA_DIR to the directory that holds it.`);
  const scratch = await mkdtemp(path.join(tmpdir(), 'volveran-copy-audit-store-'));
  try {
    const copied = await migratedCopy(file, scratch);
    // Sets up the target as startup would: refuses another encoding or a newer schema, and says why it cannot connect.
    await (await PostgresAuditStore.open(postgresUrl, tls)).close();
    return await copyInto(copied, postgresUrl, tls);
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

async function copyInto(file: string, postgresUrl: string, tls: PostgresTls | null): Promise<CopiedTable[]> {
  const source = new DatabaseSync(file, { readOnly: true });
  // A copy takes as long as the store is big, so no statement has a time limit.
  const pool = createPool(postgresUrl, { tls, queryTimeoutMs: null, max: 1 });
  try {
    // One snapshot of the source, so what is counted is what was copied.
    source.exec('BEGIN');
    const tables = sourceTables(source);
    return await transaction(pool, async (client) => {
      await refuseOtherSchema(client, tables);
      // Two copies at once: the second waits here, then finds the first one's rows.
      await client.query(`LOCK TABLE ${[...tables.keys()].map(quoted).join(', ')} IN ACCESS EXCLUSIVE MODE`);
      await refuseNonEmpty(client, tables.keys(), postgresAddress(postgresUrl));
      for (const [table, shape] of tables) await copyRows(source, client, table, shape);
      await continueIds(source, client);
      return verifyCounts(source, client, tables.keys());
    });
  } catch (err) {
    throw asStartupError(err, postgresUrl);
  } finally {
    source.close();
    await pool.end().catch(() => {});
  }
}

/** The command: the store and the target from the environment, and what it prints. */
export async function copyAuditStoreCommand(env: Record<string, string | undefined>, dataDir: string): Promise<string[]> {
  const settings = parsePostgresUrl(env);
  if (!settings.ok) throw new ConfigError(settings.error);
  if (settings.url === null) throw new ConfigError('copy-audit-store needs VOLVERAN_POSTGRES_URL, the database to copy into.');
  const copied = await copyAuditStore({ dataDir, postgresUrl: settings.url, tls: await readPostgresTls(settings.tls) });
  return [...copied.map(({ table, rows }) => `${table}: ${rows} rows, verified`), 'OK: copied, and the SQLite store was not changed. Set VOLVERAN_POSTGRES_URL on Volverán and start it.'];
}
