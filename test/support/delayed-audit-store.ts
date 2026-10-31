// The audit store as a slow database answers (ADR 0013). Each call waits first and
// only then does its work, so a caller that forgets its `await` carries on before
// the write has happened, and a write left floating at shutdown rejects on a
// closed store. On SQLite as it is, neither shows.
import type { AuditStore } from '../../src/server/audit/audit-store.js';

/** A fixed wait in ms, or a wait per call, by name (`record`, `ruleState.ensure`); a rejection fails the call. */
export type StoreDelay = number | ((call: string) => Promise<void> | void);

export function delayedAuditStore(store: AuditStore, delay: StoreDelay = 20): AuditStore {
  const wait = typeof delay === 'number' ? () => new Promise<void>((resolve) => setTimeout(resolve, delay)) : delay;
  return delayedCalls(store, wait, '');
}

function delayedCalls<T extends object>(target: T, wait: (call: string) => Promise<void> | void, prefix: string): T {
  return new Proxy(target, {
    get(_, key: string) {
      const value = (target as Record<string, unknown>)[key];
      const call = `${prefix}${key}`;
      if (typeof value === 'function') {
        return async (...args: unknown[]) => {
          await wait(call);
          return value.apply(target, args);
        };
      }
      return typeof value === 'object' && value !== null ? delayedCalls(value, wait, `${call}.`) : value;
    },
  });
}

/** Runs a suite on the store as it is and on a delayed one: `describe.each(storeSpeeds)('... (%s)', (_, wrapAuditStore) => ...)`. */
export const storeSpeeds: Array<[string, ((store: AuditStore) => AuditStore) | undefined]> = [
  ['store answering at once', undefined],
  ['delayed store', (store) => delayedAuditStore(store)],
];
