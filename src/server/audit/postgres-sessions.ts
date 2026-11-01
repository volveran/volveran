// Sessions on PostgreSQL, shared by every Replica: one started on any of them is seen
// by all, a removal takes effect on all, and a restart keeps them. Tokens arrive sealed
// (token-seal.ts). Each call is one statement or one transaction.
import type pg from 'pg';
import type { SessionStore, StoredSession, StoredSignIn } from './audit-store.js';
import { transaction } from './postgres-connection.js';

// A refresh holds a connection while it waits for the provider or for another Replica's
// refresh, so a slow provider must not take the pool from Audit Entries and sign-ins.
const MAX_REFRESHES_AT_ONCE = 3;

export class PostgresSessionStore implements SessionStore {
  private refreshSlotsInUse = 0;
  private readonly waitingForSlot: Array<() => void> = [];

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

  async refreshTokens(id: string, now: number, refresh: (tokens: string) => Promise<string | null>): Promise<boolean> {
    if (this.refreshSlotsInUse >= MAX_REFRESHES_AT_ONCE) await new Promise<void>((resolve) => this.waitingForSlot.push(resolve));
    else this.refreshSlotsInUse++;
    try {
      return await transaction(this.pool, async (client) => {
        const { rows } = await client.query<{ tokens: string }>('SELECT tokens FROM sessions WHERE id = $1 AND expires_at > $2 FOR UPDATE', [id, now]);
        const row = rows[0];
        if (!row) return false;
        const tokens = await refresh(row.tokens);
        if (tokens !== null) await client.query('UPDATE sessions SET tokens = $1 WHERE id = $2', [tokens, id]);
        return true;
      });
    } finally {
      // The slot passes straight to the next in line, if any.
      const next = this.waitingForSlot.shift();
      if (next) next();
      else this.refreshSlotsInUse--;
    }
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
