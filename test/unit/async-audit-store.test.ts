// The asynchronous audit store interface, over SQLite. Its behaviour is that of
// the synchronous store, which audit-store.test.ts and rule-state.test.ts cover
// in depth; #98 replaces those with a contract suite on this interface. Here:
// every call answers through a promise, and the two forms share one database.
import { afterEach, describe, expect, it } from 'vitest';
import type { AlertMemory } from '../../src/server/alerts/evaluation.js';
import type { AuditStore } from '../../src/server/audit/audit-store.js';
import { AuditStore as SyncAuditStore, type NewAuditEntry } from '../../src/server/audit/store.js';

// Fails to compile if a public member of the synchronous store has no counterpart
// on the interface with the same arguments and answer: the interface covers
// everything callers use today. #98 removes this with the synchronous store.
type Asyncified<T> = {
  [K in keyof T]: T[K] extends (...args: infer A) => infer R ? (...args: A) => Promise<R> : Asyncified<T[K]>;
};
type CoversTheSynchronousStore = AuditStore extends Asyncified<Omit<SyncAuditStore, 'async'>> ? true : never;
const coversTheSynchronousStore: CoversTheSynchronousStore = true;

const AT = new Date('2026-10-01T12:00:00.000Z');

function entry(overrides: Partial<NewAuditEntry> = {}): NewAuditEntry {
  return {
    at: AT,
    operator: { id: 'ana', displayName: 'Ana' },
    brokerUser: 'svc',
    profile: 'local',
    vhost: '/',
    queue: 'orders.dlq',
    messageId: 'm-1',
    action: 'discard',
    reason: 'bad payload',
    destination: null,
    checkoutId: 'c-1',
    message: { body: Buffer.from('hello'), properties: { contentType: 'text/plain' }, headers: { a: 1 } },
    ...overrides,
  };
}

it('covers everything the synchronous store offers (checked by the compiler)', () => {
  expect(coversTheSynchronousStore).toBe(true);
});

describe('the asynchronous audit store', () => {
  let sync: SyncAuditStore;
  let store: AuditStore;
  const open = () => {
    sync = new SyncAuditStore();
    store = sync.async;
  };
  afterEach(() => sync.close());

  describe('Audit Entries', () => {
    it('records a pending entry, then its outcome, and reads it back with its body', async () => {
      open();
      const id = await store.record(entry());
      expect((await store.get(id))?.outcome).toBe('pending');

      await store.setOutcome(id, 'failed', 'no route');

      expect(await store.get(id)).toMatchObject({ id, outcome: 'failed', outcomeReason: 'no route', operatorName: 'Ana' });
      expect(await store.body(id)).toEqual(Buffer.from('hello'));
      expect(await store.get(id + 1)).toBeNull();
      expect(await store.body(id + 1)).toBeNull();
    });

    it('takes an outcome without a reason', async () => {
      open();
      const id = await store.record(entry());
      await store.setOutcome(id, 'done');
      expect(await store.get(id)).toMatchObject({ outcome: 'done', outcomeReason: null });
    });

    it('records how a Canary\'s watch ended', async () => {
      open();
      const id = await store.record(entry({ action: 'replay', canary: true, message: null }));
      await store.setCanaryOutcome(id, 'died_again');
      expect(await store.get(id)).toMatchObject({ canary: true, canaryOutcome: 'died_again' });
    });

    it('searches newest first, and lists everything without a query', async () => {
      open();
      const first = await store.record(entry());
      const second = await store.record(entry({ queue: 'other.dlq' }));
      expect((await store.list()).map((e) => e.id)).toEqual([second, first]);
      expect((await store.list({ queue: 'other.dlq' })).map((e) => e.id)).toEqual([second]);
    });

    it('evicts stored bodies and reports the bytes left', async () => {
      open();
      const old = await store.record(entry());
      const kept = await store.record(entry({ at: new Date(AT.getTime() + 60_000) }));
      expect(await store.storedBodyBytes()).toBe(10);

      const { evicted } = await store.evictBodies({ now: new Date(AT.getTime() + 60_000), maxAgeMs: 1000, maxBodyBytes: 1000 });

      expect(evicted).toBe(1);
      expect(await store.body(old)).toBeNull();
      expect((await store.get(old))?.bodyExpiredAt).toEqual(new Date(AT.getTime() + 60_000));
      expect(await store.body(kept)).toEqual(Buffer.from('hello'));
      expect(await store.storedBodyBytes()).toBe(5);
    });
  });

  describe('Replay Rule state', () => {
    const KEY = 'local/transient';

    it('starts a rule as declared and keeps the stored state after that', async () => {
      open();
      expect(await store.ruleState.state(KEY)).toBeNull();
      expect((await store.ruleState.ensure(KEY, true)).paused).toBe(true);
      await store.ruleState.setPaused(KEY, null);
      expect((await store.ruleState.ensure(KEY, true)).paused).toBe(false);
      await store.ruleState.setPaused(KEY, { reason: 'stop', by: 'ana', at: AT });
      expect(await store.ruleState.state(KEY)).toEqual({ paused: true, pausedReason: 'stop', pausedBy: 'ana', pausedAt: AT.toISOString() });
    });

    it('keeps passes, first-seen times and the Died Again count', async () => {
      open();
      const pass = { id: 'p-1', at: AT.toISOString(), status: 'skipped', summary: null, reason: 'held by ana' } as const;
      await store.ruleState.recordPass(KEY, pass);
      expect(await store.ruleState.passes(KEY)).toEqual([pass]);

      expect(await store.ruleState.firstSeenAt(KEY, 'm-1')).toBeNull();
      expect(await store.ruleState.firstSeen(KEY, ['m-1'], AT)).toEqual(new Map([['m-1', AT]]));
      expect(await store.ruleState.firstSeenAt(KEY, 'm-1')).toEqual(AT);

      const id = await store.record(entry({ rule: 'transient', action: 'replay', message: null }));
      const rule = { profile: 'local', name: 'transient' };
      expect(await store.ruleState.countDiedAgain(KEY, rule, [id], AT, AT)).toBe(1);
      await store.ruleState.clearDiedAgain(KEY);
      expect(await store.ruleState.countDiedAgain(KEY, rule, [], AT, AT)).toBe(0);
    });
  });

  describe('depth history', () => {
    const queue = { profile: 'local', vhost: '/', queue: 'orders.dlq' };
    const run = (at: number, ok = true) => ({ at, ok, errorCode: ok ? null : 'unreachable', intervalMs: 1000 });

    it('records runs and their Samples, and reads them back', async () => {
      open();
      const sample = { vhost: '/', queue: 'orders.dlq', at: 1000, depth: 3, estimatedArrivals: null };
      await store.history.recordRun('local', run(1000), [sample]);
      await store.history.recordRun('local', run(2000, false), []);

      const stored = { at: 1000, depth: 3, estimatedArrivals: null };
      expect(await store.history.latestSample(queue)).toEqual(stored);
      expect(await store.history.latestSample(queue, 1000)).toBeNull();
      expect(await store.history.samples(queue, 0, 5000)).toEqual([stored]);
      expect(await store.history.runsAround('local', 1000, 2000)).toEqual([run(1000), run(2000, false)]);
      expect(await store.history.lastRuns('local')).toEqual({ last: run(2000, false), lastOk: run(1000) });
      expect(await store.history.lastGoodRunBefore('local', 2000)).toBe(1000);
      expect(await store.history.removeOlderThan(1500)).toEqual({ samples: 1, runs: 1 });
    });

    it('counts the Messages taken out, from the Audit Entries', async () => {
      open();
      const id = await store.record(entry());
      await store.setOutcome(id, 'done');
      const at = AT.getTime();
      expect(await store.history.takenOut(queue, at - 1, at)).toBe(1);
      expect(await store.history.takeOuts(queue, at, at)).toEqual([
        { checkoutId: 'c-1', at, operator: 'Ana', rule: null, counts: { discard: 1, replay: 0, move: 0 } },
      ]);
    });
  });

  describe('notifications', () => {
    it('records outcomes, lists the latest and removes the old', async () => {
      open();
      const delivery = {
        alertId: 'a-1',
        destination: 'oncall',
        destinationType: 'slack',
        status: 'firing',
        test: false,
        rule: 'deep',
        profile: 'local',
        vhost: '/',
        queue: 'orders.dlq',
        replayRule: null,
        outcome: 'delivered',
        httpStatus: 200,
        error: null,
        attempts: 1,
      } as const;
      const recorded = await store.notifications.record({ ...delivery, at: AT });
      expect(recorded).toEqual({ ...delivery, id: recorded.id, at: AT.toISOString() });
      expect(await store.notifications.recent()).toEqual([recorded]);
      expect(await store.notifications.recent(10, { profiles: { only: [] }, tests: false })).toEqual([]);
      expect(await store.notifications.removeOlderThan(new Date(AT.getTime() + 1))).toBe(1);
    });
  });

  describe('Alerts', () => {
    it('saves and loads what is remembered of a profile, and forgets rules no longer in the file', async () => {
      open();
      const memory = {
        alerts: [
          {
            alertId: 'a-1',
            rule: 'deep',
            vhost: '/',
            queue: 'orders.dlq',
            status: 'firing',
            condition: 'depthAbove',
            value: 5,
            threshold: 3,
            since: 1000,
            lastNotifiedAt: 1000,
            falseSince: null,
            replayRule: null,
            reason: null,
          },
        ],
        arrivals: [{ vhost: '/', queue: 'orders.dlq', unsettled: 2, recent: [] }],
      } satisfies AlertMemory;
      expect(await store.alerts.load('local')).toEqual({ alerts: [], arrivals: [] });
      await store.alerts.save('local', memory);
      expect(await store.alerts.load('local')).toEqual(memory);
      await store.alerts.keepOnly(new Map([['local', []]]));
      expect(await store.alerts.load('local')).toEqual({ alerts: [], arrivals: memory.arrivals });
    });
  });

  describe('the two forms during the migration', () => {
    it('share one database, so a caller on either sees what the other wrote', async () => {
      open();
      const written = sync.record(entry());
      expect((await store.get(written))?.messageId).toBe('m-1');
      const id = await store.record(entry({ messageId: 'm-2' }));
      expect(sync.get(id)?.messageId).toBe('m-2');
    });
  });

  describe('failures', () => {
    it('rejects rather than throws, so a caller has one way to handle a store failure', async () => {
      open();
      await store.close();
      const call = () => store.record(entry());
      let promise: Promise<number> | undefined;
      expect(() => {
        promise = call();
      }).not.toThrow();
      await expect(promise).rejects.toThrow();
    });

    it('closes more than once', async () => {
      open();
      await store.close();
      await expect(store.close()).resolves.toBeUndefined();
    });
  });
});
