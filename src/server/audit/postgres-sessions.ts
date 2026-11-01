// Sessions on PostgreSQL, shared by every Replica: one started on any of them is seen
// by all, a removal takes effect on all, and a restart keeps them. Tokens arrive sealed
// (token-seal.ts). Each call is one statement or one transaction.
import type pg from 'pg';
import type { SessionStore, StoredSession, StoredSignIn } from './audit-store.js';
import { transaction } from './postgres-connection.js';

export class PostgresSessionStore implements SessionStore {
  constructor(private readonly pool: pg.Pool) {}

  async addSession(id: string, session: StoredSession, now: number): Promise<void> {
    await transaction(this.pool, async (client) => {
      await client.query('DELETE FROM sessions WHERE expires_at <= $1', [now]);
      await client.query('INSERT INTO sessions (id, operator, tokens, expires_at) VALUES ($1, $2, $3, $4)', [id, JSON.stringify(session.operator), session.tokens, session.expiresAt]);
    });
  }

  async session(id: string, now: number): Promise<StoredSession | null> {
    const { rows } = await this.pool.query<{ operator: string; tokens: string; expires_at: number }>('SELECT operator, tokens, expires_at FROM sessions WHERE id = $1 AND expires_at > $2', [id, now]);
    const row = rows[0];
    return row ? { operator: JSON.parse(row.operator) as StoredSession['operator'], tokens: row.tokens, expiresAt: row.expires_at } : null;
  }

  async setTokens(id: string, tokens: string): Promise<void> {
    await this.pool.query('UPDATE sessions SET tokens = $1 WHERE id = $2', [tokens, id]);
  }

  async removeSession(id: string): Promise<void> {
    await this.pool.query('DELETE FROM sessions WHERE id = $1', [id]);
  }

  async addSignIn(id: string, signIn: StoredSignIn, now: number): Promise<void> {
    await transaction(this.pool, async (client) => {
      await client.query('DELETE FROM sign_ins WHERE expires_at <= $1', [now]);
      await client.query('INSERT INTO sign_ins (id, sealed, expires_at) VALUES ($1, $2, $3)', [id, signIn.sealed, signIn.expiresAt]);
    });
  }

  async takeSignIn(id: string, now: number): Promise<string | null> {
    const { rows } = await this.pool.query<{ sealed: string; expires_at: number }>('DELETE FROM sign_ins WHERE id = $1 RETURNING sealed, expires_at', [id]);
    const row = rows[0];
    return row && row.expires_at > now ? row.sealed : null;
  }
}
