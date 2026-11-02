// Tells of each call on the audit store's interface that fails, whoever made it and
// whether or not they cope, so partial failure can be alerted on. A former leader's write
// refused by the fence is the fence working, not an error.
import { LeaderLeaseLost, type AuditStore } from '../audit/audit-store.js';

export function reportingStoreErrors(store: AuditStore, onError: (err: unknown) => void): AuditStore {
  const report = (err: unknown) => {
    if (!(err instanceof LeaderLeaseLost)) onError(err);
  };
  const reporting = <T extends object>(target: T): T =>
    new Proxy(target, {
      get(_, key) {
        const value: unknown = Reflect.get(target, key, target);
        if (typeof value === 'object' && value !== null) return reporting(value);
        if (typeof value !== 'function') return value;
        return (...args: unknown[]) => {
          try {
            const answer: unknown = value.apply(target, args);
            if (answer instanceof Promise) answer.catch(report);
            return answer;
          } catch (err) {
            report(err);
            throw err;
          }
        };
      },
    });
  return reporting(store);
}
