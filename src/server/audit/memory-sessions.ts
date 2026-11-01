// Sessions on SQLite: in this process's memory, as one Replica needs no more, so a
// restart signs everyone out and nothing about a session reaches the data volume.
import type { SessionStore, StoredSession, StoredSignIn } from './audit-store.js';

function sweep(entries: Map<string, { expiresAt: number; idleExpiresAt?: number }>, now: number): void {
  for (const [id, entry] of entries) if (entry.expiresAt <= now || (entry.idleExpiresAt ?? now + 1) <= now) entries.delete(id);
}

export class MemorySessionStore implements SessionStore {
  private readonly sessions = new Map<string, StoredSession>();
  private readonly signIns = new Map<string, StoredSignIn>();

  async addSession(id: string, session: StoredSession, now: number): Promise<void> {
    sweep(this.sessions, now);
    this.sessions.set(id, session);
  }

  async session(id: string, now: number): Promise<StoredSession | null> {
    const session = this.sessions.get(id);
    return session && session.expiresAt > now && session.idleExpiresAt > now ? session : null;
  }

  async setTokens(id: string, tokens: string): Promise<void> {
    const session = this.sessions.get(id);
    if (session) this.sessions.set(id, { ...session, tokens });
  }

  async touchSession(id: string, idleExpiresAt: number): Promise<void> {
    const session = this.sessions.get(id);
    if (session) this.sessions.set(id, { ...session, idleExpiresAt });
  }

  async removeSession(id: string): Promise<void> {
    this.sessions.delete(id);
  }

  async addSignIn(id: string, signIn: StoredSignIn, now: number, keepAtMost: number): Promise<void> {
    sweep(this.signIns, now);
    this.signIns.set(id, signIn);
    // A Map keeps the order things were added, and every sign-in lasts as long as the others.
    for (const oldest of this.signIns.keys()) {
      if (this.signIns.size <= keepAtMost) break;
      this.signIns.delete(oldest);
    }
  }

  async takeSignIn(id: string, now: number): Promise<string | null> {
    const signIn = this.signIns.get(id);
    this.signIns.delete(id);
    return signIn && signIn.expiresAt > now ? signIn.sealed : null;
  }
}
