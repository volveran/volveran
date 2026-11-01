// What counts as an error of the audit store: every call that fails, at any depth of the
// interface, but not a former leader's write that the fence refused as it should.
import { describe, expect, it } from 'vitest';
import { LeaderLeaseLost, type AuditStore } from '../../src/server/audit/audit-store.js';
import { reportingStoreErrors } from '../../src/server/metrics/store-errors.js';

function store(calls: Record<string, unknown>): { wrapped: AuditStore; errors: unknown[] } {
  const errors: unknown[] = [];
  return { wrapped: reportingStoreErrors(calls as unknown as AuditStore, (err) => errors.push(err)), errors };
}

describe('reportingStoreErrors', () => {
  it('answers what the store answers, and reports nothing', async () => {
    const { wrapped, errors } = store({
      id: 7,
      async record(this: { id: number }) {
        return this.id;
      },
      alerts: {
        async load() {
          return 'memory';
        },
      },
    });
    await expect(wrapped.record({} as never)).resolves.toBe(7);
    await expect(wrapped.alerts.load('p')).resolves.toBe('memory');
    expect(errors).toEqual([]);
  });

  it('reports a rejected call and rejects as the store did, at any depth', async () => {
    const broken = new Error('broken');
    const reject = async () => {
      throw broken;
    };
    const { wrapped, errors } = store({ ping: reject, alerts: { load: reject } });
    await expect(wrapped.ping()).rejects.toBe(broken);
    await expect(wrapped.alerts.load('p')).rejects.toBe(broken);
    expect(errors).toEqual([broken, broken]);
  });

  it('reports a call that throws at once', () => {
    const broken = new Error('broken');
    const { wrapped, errors } = store({
      ping() {
        throw broken;
      },
    });
    expect(() => wrapped.ping()).toThrow(broken);
    expect(errors).toEqual([broken]);
  });

  it('does not take a refused write of a former leader for an error', async () => {
    const { wrapped, errors } = store({
      async evictBodies() {
        throw new LeaderLeaseLost();
      },
    });
    await expect(wrapped.evictBodies({} as never)).rejects.toBeInstanceOf(LeaderLeaseLost);
    expect(errors).toEqual([]);
  });
});
