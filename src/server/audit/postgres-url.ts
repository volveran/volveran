// VOLVERAN_POSTGRES_URL: setting it makes PostgreSQL the audit store; no URL means
// SQLite. A URL can hold a password, so a message about it never repeats it.
export function parsePostgresUrl(env: Record<string, string | undefined>): { ok: true; url: string | null } | { ok: false; error: string } {
  const value = env.VOLVERAN_POSTGRES_URL;
  if (value === undefined) return { ok: true, url: null };
  const refused = { ok: false, error: 'VOLVERAN_POSTGRES_URL must be a postgres:// or postgresql:// URL (unset it to keep the audit store on SQLite).' } as const;
  if (!URL.canParse(value)) return refused;
  const { protocol } = new URL(value);
  return protocol === 'postgres:' || protocol === 'postgresql:' ? { ok: true, url: value } : refused;
}
