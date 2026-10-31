// VOLVERAN_POSTGRES_URL: setting it makes PostgreSQL the audit store; no URL means
// SQLite. A URL can hold a password, so a message about it never repeats it.
// VOLVERAN_POSTGRES_REQUIRE_TLS and VOLVERAN_POSTGRES_CA_FILE ask for TLS with a
// verified certificate, with the system's CAs or the ones in that file.

import { readFile } from 'node:fs/promises';
import { ConfigError } from '../config-error.js';
import type { PostgresTls } from './postgres-connection.js';

/** Parameters of the URL that say something about TLS of their own, which would override these variables. */
const TLS_URL_PARAMETERS = ['ssl', 'sslmode', 'sslrootcert'];

export type PostgresSettings = { ok: true; url: string | null; tls: { caFile: string | null } | null } | { ok: false; error: string };

export function parsePostgresUrl(env: Record<string, string | undefined>): PostgresSettings {
  const value = env.VOLVERAN_POSTGRES_URL;
  const requireTls = env.VOLVERAN_POSTGRES_REQUIRE_TLS;
  const caFile = env.VOLVERAN_POSTGRES_CA_FILE || null;
  if (requireTls !== undefined && requireTls !== 'true' && requireTls !== 'false') {
    return { ok: false, error: 'VOLVERAN_POSTGRES_REQUIRE_TLS must be true or false.' };
  }
  const tls = requireTls === 'true' || caFile ? { caFile } : null;
  if (value === undefined) {
    if (tls) return { ok: false, error: 'VOLVERAN_POSTGRES_REQUIRE_TLS and VOLVERAN_POSTGRES_CA_FILE need VOLVERAN_POSTGRES_URL: the audit store is on SQLite without it.' };
    return { ok: true, url: null, tls: null };
  }
  const refused = { ok: false, error: 'VOLVERAN_POSTGRES_URL must be a postgres:// or postgresql:// URL (unset it to keep the audit store on SQLite).' } as const;
  if (!URL.canParse(value)) return refused;
  const { protocol, searchParams } = new URL(value);
  if (protocol !== 'postgres:' && protocol !== 'postgresql:') return refused;
  if (requireTls === 'false' && caFile) return { ok: false, error: 'VOLVERAN_POSTGRES_REQUIRE_TLS is false but VOLVERAN_POSTGRES_CA_FILE is set: a CA is only for TLS.' };
  if (tls && TLS_URL_PARAMETERS.some((p) => searchParams.has(p))) {
    return { ok: false, error: `With VOLVERAN_POSTGRES_REQUIRE_TLS or VOLVERAN_POSTGRES_CA_FILE, leave ${TLS_URL_PARAMETERS.join(', ')} out of VOLVERAN_POSTGRES_URL: they would override them.` };
  }
  return { ok: true, url: value, tls };
}

/** The TLS settings with the CA file's certificates read. */
export async function readPostgresTls(tls: { caFile: string | null } | null): Promise<PostgresTls | null> {
  if (!tls?.caFile) return tls && {};
  try {
    return { ca: await readFile(tls.caFile, 'utf8') };
  } catch (err) {
    throw new ConfigError(`VOLVERAN_POSTGRES_CA_FILE could not be read: ${(err as Error).message}`);
  }
}
