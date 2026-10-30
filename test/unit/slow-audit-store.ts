// The audit store as PostgreSQL would answer it: nothing has happened when a
// call returns, and a write takes longer than a read. A missing await that
// SQLite hides shows here (ADR 0013).
import { setTimeout as sleep } from 'node:timers/promises';
import type { AuditStore } from '../../src/server/audit/audit-store.js';

const WRITES = new Set<string | symbol>(['record', 'setOutcome']);

export function slowAuditStore(store: AuditStore): AuditStore {
  return new Proxy(store, {
    get(target, key) {
      const member = Reflect.get(target, key) as unknown;
      if (typeof member !== 'function') return member;
      return async (...args: unknown[]) => {
        await sleep(WRITES.has(key) ? 20 : 2);
        return member.apply(target, args);
      };
    },
  });
}
