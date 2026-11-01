// What any audit store must do (ADR 0013): one suite of behaviour tests against the
// interface, run once per implementation. It takes the implementation as a parameter
// and looks at nothing but the interface, so nothing here knows which database answers.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AlertMemory } from '../../src/server/alerts/evaluation.js';
import { ConfigError } from '../../src/server/config-error.js';
import {
  FIRST_SEEN_LIMIT,
  PASS_HISTORY,
  type AuditQuery,
  LeaderLeaseLost,
  type AuditStore,
  type LeaseFence,
  type NewAuditEntry,
  type NewNotificationDelivery,
  type QueueSample,
  type StoredSamplingRun,
  type StoredSession,
} from '../../src/server/audit/audit-store.js';
import { replayTrail } from '../../src/server/audit/replay-trail.js';
import { diedAgain } from '../../src/server/triage/died-again.js';
import type { RulePass } from '../../src/shared/replay-rules.js';

/** An empty store, and a way back to what it holds once it is closed. */
export interface OpenedAuditStore {
  store: AuditStore;
  /** A new store on the same data, as after a restart. */
  reopen(): Promise<AuditStore>;
  /** Marks the data, with every store on it closed, as written by a later version of Volverán. */
  makeNewer(): Promise<void>;
  /** Removes what the store left behind; every store it opened is closed by then. */
  cleanup(): Promise<void>;
}

const AT = new Date('2026-10-01T12:00:00.000Z');
const DAY = 24 * 60 * 60 * 1000;
const after = (ms: number) => new Date(AT.getTime() + ms);

function entry(overrides: Partial<NewAuditEntry> = {}): NewAuditEntry {
  return {
    at: AT,
    operator: { id: 'sub-123', displayName: 'ana@example.com' },
    brokerUser: 'volveran-admin',
    profile: 'local',
    vhost: '/',
    queue: 'orders.dlq',
    messageId: 'm-1',
    action: 'discard',
    reason: 'duplicate order',
    destination: null,
    checkoutId: 'c-1',
    message: null,
    ...overrides,
  };
}

/** The Audit Entry of a pause or resume of the rule `local/r`: no Message. */
const ruleEntry = (action: 'rule_pause' | 'rule_resume', overrides: Partial<NewAuditEntry> = {}) => ({ ...entry({ action, messageId: null, checkoutId: null, rule: 'r', ...overrides }), message: null });

export function auditStoreContract(name: string, open: () => Promise<OpenedAuditStore>): void {
  // Some of these write thousands of rows; a database over a network takes its time.
  describe(`the audit store contract: ${name}`, { timeout: 60_000 }, () => {
    let opened: OpenedAuditStore;
    let stores: AuditStore[];
    let store: AuditStore;
    const reopen = async () => {
      await store.close();
      store = await opened.reopen();
      stores.push(store);
    };

    beforeEach(async () => {
      opened = await open();
      store = opened.store;
      stores = [store];
    });
    afterEach(async () => {
      await Promise.all(stores.map((s) => s.close()));
      await opened.cleanup();
    });

    describe('Audit Entries', () => {
      it('records a pending entry with who, where and why, then its outcome', async () => {
        const id = await store.record(entry());

        expect(await store.get(id)).toMatchObject({
          id,
          at: AT,
          operatorId: 'sub-123',
          operatorName: 'ana@example.com',
          brokerUser: 'volveran-admin',
          profile: 'local',
          vhost: '/',
          queue: 'orders.dlq',
          messageId: 'm-1',
          action: 'discard',
          reason: 'duplicate order',
          destination: null,
          checkoutId: 'c-1',
          outcome: 'pending',
          outcomeReason: null,
          message: null,
        });

        await store.setOutcome(id, 'failed', 'channel closed');
        expect(await store.get(id)).toMatchObject({ outcome: 'failed', outcomeReason: 'channel closed' });
      });

      it('takes an outcome without a reason', async () => {
        const id = await store.record(entry());
        await store.setOutcome(id, 'done');
        expect(await store.get(id)).toMatchObject({ outcome: 'done', outcomeReason: null });
      });

      it('answers null for an entry that does not exist', async () => {
        const id = await store.record(entry());
        expect(await store.get(id + 1000)).toBeNull();
        expect(await store.body(id + 1000)).toBeNull();
      });

      it('keeps a byte-identical copy of the Message, with properties and headers exactly as amqplib decoded them', async () => {
        const body = Buffer.from([0, 1, 2, 254, 255]);
        const properties = { messageId: 'm-1', contentType: 'application/octet-stream', timestamp: 1792139557 };
        const headers = {
          raw: Buffer.from([9, 8]),
          big: 12345678901234567890n,
          $odd: 'dollar key',
          'x-death': [{ queue: 'orders.work', reason: 'rejected', count: 1, 'routing-keys': ['orders.created'] }],
        };
        const id = await store.record(entry({ message: { body, properties, headers } }));

        expect((await store.get(id))?.message).toEqual({ properties, headers, bodyBytes: 5 });
        expect((await store.body(id))?.equals(body)).toBe(true);
      });

      it('keeps an empty body as a body', async () => {
        const id = await store.record(entry({ message: { body: Buffer.alloc(0), properties: {}, headers: {} } }));
        expect((await store.get(id))?.message?.bodyBytes).toBe(0);
        expect((await store.body(id))?.length).toBe(0);
      });

      it('records where a Message went and its original headers, without a body (Replay, Move)', async () => {
        const destination = { exchange: '', routingKey: 'triage.manual', queue: 'triage.manual' };
        const id = await store.record(
          entry({ action: 'move', reason: null, destination, message: { body: null, properties: { messageId: 'm-1' }, headers: { tenant: 'acme' } } }),
        );

        expect(await store.get(id)).toMatchObject({
          destination,
          message: { properties: { messageId: 'm-1' }, headers: { tenant: 'acme' }, bodyBytes: null },
        });
        expect(await store.body(id)).toBeNull();
      });

      it("marks an Apply's Canary and records how its watch ended", async () => {
        const canary = await store.record(entry({ canary: true }));
        const other = await store.record(entry());
        expect(await store.get(canary)).toMatchObject({ canary: true, canaryOutcome: null });

        await store.setCanaryOutcome(canary, 'died_again');

        expect(await store.get(canary)).toMatchObject({ canary: true, canaryOutcome: 'died_again' });
        expect(await store.get(other)).toMatchObject({ canary: false, canaryOutcome: null });
      });

      it('records the Replay Rule and Rule Pass that wrote an entry', async () => {
        const byRule = await store.record(entry({ rule: 'db-timeouts', rulePassId: 'pass-1' }));
        const byPerson = await store.record(entry());
        expect(await store.get(byRule)).toMatchObject({ rule: 'db-timeouts', rulePassId: 'pass-1' });
        expect(await store.get(byPerson)).toMatchObject({ rule: null, rulePassId: null });
      });

      it('records who approved an Apply, and no one when it needed no Approval', async () => {
        const approved = await store.record(entry({ approver: { id: 'alan-sub', displayName: 'alan@example.com' } }));
        const alone = await store.record(entry());
        expect(await store.get(approved)).toMatchObject({ approverId: 'alan-sub', approverName: 'alan@example.com' });
        expect(await store.get(alone)).toMatchObject({ approverId: null, approverName: null });
      });

      it("records the Operator's Role and an Apply's Replay Rate, and none when there is none", async () => {
        const paced = await store.record(entry({ role: 'operator', rate: 2.5 }));
        const plain = await store.record(entry());
        expect(await store.get(paced)).toMatchObject({ role: 'operator', rate: 2.5 });
        expect(await store.get(plain)).toMatchObject({ role: null, rate: null });
      });

      it('records an export with its filter and Message count, and no Message copy', async () => {
        const filter = [{ kind: 'header' as const, name: 'tenant', value: 'acme' }];
        const filtered = await store.record(entry({ action: 'export', messageId: null, reason: null, filter, messageCount: 2 }));
        const all = await store.record(entry({ action: 'export', messageId: null, reason: null, messageCount: 5 }));
        const discarded = await store.record(entry());

        expect(await store.get(filtered)).toMatchObject({ action: 'export', filter, messageCount: 2, message: null });
        expect(await store.get(all)).toMatchObject({ filter: null, messageCount: 5 });
        expect(await store.get(discarded)).toMatchObject({ filter: null, messageCount: null });
      });

      it('keeps entries and bodies across a restart', async () => {
        const id = await store.record(entry({ message: { body: Buffer.from('hello'), properties: {}, headers: {} } }));

        await reopen();

        expect(await store.get(id)).toMatchObject({ messageId: 'm-1', outcome: 'pending' });
        expect((await store.body(id))?.toString()).toBe('hello');
      });

      it('gives each of many calls at once its own entry', async () => {
        const ids = await Promise.all(Array.from({ length: 20 }, (_, i) => store.record(entry({ messageId: `m-${i}` }))));
        expect(new Set(ids).size).toBe(20);
        for (const [i, id] of ids.entries()) expect((await store.get(id))?.messageId).toBe(`m-${i}`);
      });
    });

    describe('plain text', () => {
      const NUL = 'a\0b';
      const everyTextField = entry({
        operator: { id: NUL, displayName: NUL },
        approver: { id: NUL, displayName: NUL },
        brokerUser: NUL,
        profile: NUL,
        vhost: NUL,
        queue: NUL,
        messageId: NUL,
        reason: NUL,
        destination: { exchange: NUL, routingKey: NUL, queue: NUL },
        checkoutId: NUL,
        replayId: NUL,
        rule: NUL,
        rulePassId: NUL,
      });

      it('keeps a NUL in every plain text field of an entry and its outcome, also after a restart', async () => {
        const id = await store.record(everyTextField);
        await store.setOutcome(id, 'failed', NUL);

        await reopen();

        const expected = {
          operatorId: NUL,
          operatorName: NUL,
          approverId: NUL,
          approverName: NUL,
          brokerUser: NUL,
          profile: NUL,
          vhost: NUL,
          queue: NUL,
          messageId: NUL,
          reason: NUL,
          destination: { exchange: NUL, routingKey: NUL, queue: NUL },
          checkoutId: NUL,
          replayId: NUL,
          rule: NUL,
          rulePassId: NUL,
          outcome: 'failed',
          outcomeReason: NUL,
        };
        expect(await store.get(id)).toMatchObject(expected);
        expect(await store.list()).toEqual([expect.objectContaining(expected)]);
      });

      it('finds a value with a NUL by every text field a search can name', async () => {
        const id = await store.record(everyTextField);
        const queries: AuditQuery[] = [
          { queue: NUL },
          { messageId: NUL },
          { checkoutId: NUL },
          { replayId: NUL },
          { profile: NUL },
          { operator: NUL },
          { rule: NUL },
          { profiles: { only: [NUL] } },
        ];
        for (const query of queries) {
          expect((await store.list(query)).map((e) => e.id)).toEqual([id]);
        }
        expect(await store.list({ profiles: { except: [NUL] } })).toEqual([]);
      });

      it('tells apart values that differ only around a NUL, whatever they look like', async () => {
        // The last ones are what a store might write instead of a NUL.
        const values = [NUL, 'ab', 'a b', 'a\0\0b', 'a\\0b', 'a\\u0000b', 'a␀0b', 'a␀␀b', 'a␀b', '␀', '\0', '\\'];
        const ids = new Map<string, number>();
        for (const value of values) ids.set(value, await store.record(entry({ messageId: value })));

        for (const value of values) {
          const [found, ...others] = await store.list({ messageId: value });
          expect(others).toEqual([]);
          expect(found).toMatchObject({ id: ids.get(value), messageId: value });
        }
      });

      it('keeps a NUL in Replay Rule state, and finds its first-seen time again', async () => {
        const key = `local/${NUL}`;
        const ids = [NUL, 'ab', '\0'];

        const seen = await store.ruleState.firstSeen(key, ids, AT);
        expect([...seen.keys()].sort()).toEqual([...ids].sort());
        await store.ruleState.firstSeen(key, ids, after(1000));

        expect(await store.ruleState.firstSeen(key, [NUL], after(2000))).toEqual(new Map([[NUL, AT]]));
        expect(await store.ruleState.firstSeenAt(key, [NUL, 'a\0'])).toEqual(new Map([[NUL, AT]]));

        await store.ruleState.ensure(key, false);
        await store.ruleState.pause(key, { reason: NUL, by: NUL, at: AT }, ruleEntry('rule_pause'));
        expect(await store.ruleState.state(key)).toMatchObject({ paused: true, pausedReason: NUL, pausedBy: NUL });
        await store.ruleState.recordPass(key, { id: NUL, at: AT.toISOString(), status: 'failed', reason: NUL, summary: null });
        expect(await store.ruleState.passes(key)).toMatchObject([{ id: NUL, reason: NUL }]);

        const entryId = await store.record(entry({ profile: NUL, rule: NUL }));
        expect(await store.ruleState.countDiedAgain(key, { profile: NUL, name: NUL }, [entryId], AT, AT)).toBe(1);
      });

      it('keeps a NUL in depth history, and counts what was taken out of such a queue', async () => {
        const queue = { profile: NUL, vhost: NUL, queue: NUL };
        await store.history.recordRun(NUL, { at: 1000, ok: false, errorCode: NUL, intervalMs: 60_000 }, [{ vhost: NUL, queue: NUL, at: 1000, depth: 3, estimatedArrivals: null }]);
        expect(await store.history.latestSample(queue)).toMatchObject({ depth: 3 });
        expect((await store.history.lastRuns(NUL)).last).toMatchObject({ errorCode: NUL });

        const id = await store.record(entry({ at: new Date(2000), profile: NUL, vhost: NUL, queue: NUL, checkoutId: NUL, operator: { id: 'o', displayName: NUL } }));
        await store.setOutcome(id, 'done');

        expect(await store.history.takenOut(queue, 1000, 3000)).toBe(1);
        expect(await store.history.takeOuts(queue, 1000, 3000)).toMatchObject([{ checkoutId: NUL, operator: NUL, counts: { discard: 1 } }]);
      });

      it('keeps a NUL in the outcome of a notification', async () => {
        const recorded = await store.notifications.record({
          at: AT, alertId: NUL, destination: NUL, destinationType: 'slack', status: 'firing', test: false, rule: NUL,
          profile: NUL, vhost: NUL, queue: NUL, replayRule: NUL, outcome: 'failed', httpStatus: null, error: NUL, attempts: 1,
        });

        expect(await store.notifications.recent()).toEqual([recorded]);
        expect(await store.notifications.recent(10, { profiles: { only: [NUL] }, tests: false })).toEqual([recorded]);
      });

      it('keeps a NUL in Alerts, in the order of a store that holds it as it is', async () => {
        const alert = (queue: string): AlertMemory['alerts'][number] => ({
          alertId: NUL, rule: NUL, vhost: NUL, queue, status: 'firing', condition: 'depthAbove', value: null, threshold: null,
          since: 1000, lastNotifiedAt: null, falseSince: null, replayRule: NUL, reason: NUL,
        });
        // Bytewise: NUL first, then what might stand for it, then the rest.
        const queues = ['a', 'a\0', 'a\0\0', 'a\0b', 'a\u0001', 'a\u0002', 'aa', 'a\u2400'];
        const memory: AlertMemory = {
          alerts: queues.map(alert),
          arrivals: queues.map((queue) => ({ vhost: NUL, queue, unsettled: 1, recent: [] })),
        };
        await store.alerts.save(NUL, { alerts: [...memory.alerts].reverse(), arrivals: [...memory.arrivals].reverse() });

        expect(await store.alerts.load(NUL)).toEqual(memory);
        await store.alerts.keepOnly(new Map([[NUL, []]]));
        expect((await store.alerts.load(NUL)).alerts).toEqual([]);
      });

      it('stores half of a surrogate pair as the replacement character, as UTF-8 cannot hold it', async () => {
        const id = await store.record(entry({ messageId: 'a\ud800b', reason: 'a\ud800b' }));

        expect(await store.get(id)).toMatchObject({ messageId: 'a\ufffdb', reason: 'a\ufffdb' });
      });

      it('keeps a NUL in the properties, headers and filter it holds as JSON', async () => {
        const id = await store.record(
          entry({
            filter: { all: [{ field: 'messageId', op: 'contains', value: NUL }] } as unknown as NewAuditEntry['filter'],
            message: { body: null, properties: { messageId: NUL, appId: 'a␀0b' }, headers: { [NUL]: NUL, nested: { list: [NUL] } } },
          }),
        );

        const found = await store.get(id);
        expect(found?.filter).toEqual({ all: [{ field: 'messageId', op: 'contains', value: NUL }] });
        expect(found?.message?.properties).toEqual({ messageId: NUL, appId: 'a␀0b' });
        expect(found?.message?.headers).toEqual({ [NUL]: NUL, nested: { list: [NUL] } });
      });

      it('settles a Message whose id has a NUL: a Restore of it can be written too', async () => {
        const discard = await store.record(entry({ messageId: NUL, message: { body: Buffer.from('x'), properties: { messageId: NUL }, headers: {} } }));
        await store.setOutcome(discard, 'done');
        const restore = await store.record(entry({ action: 'restore', messageId: (await store.get(discard))!.messageId, restoreOf: discard }));

        expect((await store.list({ restoreOf: discard })).map((e) => [e.id, e.messageId])).toEqual([[restore, NUL]]);
        expect(await store.body(discard)).toEqual(Buffer.from('x'));
      });
    });

    describe('search', () => {
      const ids = async (query?: AuditQuery) => (await store.list(query)).map((e) => e.id);

      it('lists every entry newest first without a query, and without bodies', async () => {
        const older = await store.record(entry({ at: after(-1000), message: { body: Buffer.from('x'), properties: {}, headers: {} } }));
        const newer = await store.record(entry());

        expect(await ids()).toEqual([newer, older]);
        expect(JSON.stringify(await store.list())).not.toContain('"body":');
      });

      it('orders entries of the same moment by when they were recorded', async () => {
        const first = await store.record(entry());
        const second = await store.record(entry());
        const third = await store.record(entry());
        expect(await ids()).toEqual([third, second, first]);
      });

      it('finds entries by queue, including a queue a Message was sent to', async () => {
        const destination = { exchange: '', routingKey: 'triage.manual', queue: 'triage.manual' };
        const moved = await store.record(entry({ action: 'move', destination }));
        const other = await store.record(entry({ queue: 'payments.dlq' }));
        expect(await ids({ queue: 'orders.dlq' })).toEqual([moved]);
        expect(await ids({ queue: 'triage.manual' })).toEqual([moved]);
        expect(await ids({ queue: 'payments.dlq' })).toEqual([other]);
        expect(await ids({ queue: 'nowhere' })).toEqual([]);
      });

      it('finds entries by message id, action, Checkout, replay id, Broker Profile and Replay Rule', async () => {
        const plain = await store.record(entry());
        const other = await store.record(
          entry({ messageId: 'm-2', action: 'replay', checkoutId: 'c-2', replayId: 'r-1', profile: 'staging', rule: 'db-timeouts' }),
        );
        const both: AuditQuery[] = [{ messageId: 'm-2' }, { action: 'replay' }, { checkoutId: 'c-2' }, { replayId: 'r-1' }, { profile: 'staging' }, { rule: 'db-timeouts' }];
        for (const query of both) expect(await ids(query)).toEqual([other]);
        expect(await ids({ messageId: 'm-1' })).toEqual([plain]);
        expect(await ids({ replayId: 'nope' })).toEqual([]);
      });

      it('finds entries by Operator, stable id or display name', async () => {
        const ana = await store.record(entry());
        await store.record(entry({ operator: { id: 'sub-9', displayName: 'alan' } }));
        expect(await ids({ operator: 'sub-123' })).toEqual([ana]);
        expect(await ids({ operator: 'ana@example.com' })).toEqual([ana]);
      });

      it('finds the Restores of a Discard', async () => {
        const discard = await store.record(entry());
        const restore = await store.record(entry({ action: 'restore', restoreOf: discard, reason: null }));
        await store.record(entry());
        expect(await ids({ restoreOf: discard })).toEqual([restore]);
        expect((await store.get(restore))?.restoreOf).toBe(discard);
        expect((await store.get(discard))?.restoreOf).toBeNull();
      });

      it('keeps only the Broker Profiles of a scope', async () => {
        const local = await store.record(entry());
        const staging = await store.record(entry({ profile: 'staging' }));
        const prod = await store.record(entry({ profile: 'prod' }));
        expect(await ids({ profiles: { only: ['local', 'prod'] } })).toEqual([prod, local]);
        expect(await ids({ profiles: { except: ['local', 'prod'] } })).toEqual([staging]);
        expect(await ids({ profiles: { only: [] } })).toEqual([]);
        expect(await ids({ profiles: { except: [] } })).toEqual([prod, staging, local]);
      });

      it('takes a time range, both ends included', async () => {
        await store.record(entry({ at: after(-1) }));
        const start = await store.record(entry());
        const end = await store.record(entry({ at: after(1000) }));
        await store.record(entry({ at: after(1001) }));
        expect(await ids({ from: AT, to: after(1000) })).toEqual([end, start]);
      });

      it('limits to the newest, after matching every given field', async () => {
        const oldest = await store.record(entry({ at: after(-2000) }));
        const middle = await store.record(entry({ at: after(-1000) }));
        await store.record(entry({ queue: 'payments.dlq' }));
        expect(await ids({ queue: 'orders.dlq', limit: 2 })).toEqual([middle, oldest]);
        expect(await ids({ queue: 'orders.dlq', action: 'discard', from: after(-1000) })).toEqual([middle]);
      });
    });

    describe('replay trail', () => {
      const headers = (replayId?: string) => (replayId ? { 'x-volveran-replay-id': replayId } : {});
      const copy = (replayId?: string) => ({ body: null, properties: {}, headers: headers(replayId) });

      it('follows a Replay, and a Restore through the Discard it republished', async () => {
        await store.record(entry({ action: 'replay', replayId: 'r1', message: copy() }));
        const discard = await store.record(entry({ message: { ...copy('r1'), body: Buffer.from('x') } }));
        const restore = await store.record(entry({ action: 'restore', restoreOf: discard, replayId: 'r2' }));

        expect(await diedAgain(headers('r2'), replayTrail(store))).toMatchObject({
          replayId: 'r2',
          count: 2,
          last: { auditEntryId: restore, action: 'restore' },
        });
      });

      it('shows nothing of a Broker Profile outside the scope', async () => {
        await store.record(entry({ action: 'replay', replayId: 'r1', message: copy() }));
        const trail = replayTrail(store, { only: ['other'] });
        expect(await diedAgain(headers('r1'), trail)).toEqual({ replayId: 'r1', count: 1, last: null });
      });
    });

    describe('retention', () => {
      const NO_SIZE_LIMIT = Number.MAX_SAFE_INTEGER;
      const NOW = AT;
      const discard = (messageId: string, ageMs: number, bytes: number) =>
        store.record(entry({ messageId, at: new Date(NOW.getTime() - ageMs), message: { body: Buffer.alloc(bytes, 'x'), properties: { messageId }, headers: {} } }));

      it('evicts the bodies older than the age limit and keeps their entries, marked body expired', async () => {
        const old = await discard('old', 31 * DAY, 10);
        const young = await discard('young', 29 * DAY, 10);

        expect(await store.evictBodies({ now: NOW, maxAgeMs: 30 * DAY, maxBodyBytes: NO_SIZE_LIMIT })).toEqual({ evicted: 1 });

        expect(await store.body(old)).toBeNull();
        expect(await store.get(old)).toMatchObject({ messageId: 'old', bodyExpiredAt: NOW, message: { bodyBytes: 10 } });
        expect(await store.body(young)).toEqual(Buffer.alloc(10, 'x'));
        expect((await store.get(young))?.bodyExpiredAt).toBeNull();
      });

      it('evicts the oldest bodies until the rest fit in the size limit', async () => {
        const oldest = await discard('oldest', 3 * DAY, 40);
        const middle = await discard('middle', 2 * DAY, 40);
        const newest = await discard('newest', 1 * DAY, 40);

        expect(await store.evictBodies({ now: NOW, maxAgeMs: 30 * DAY, maxBodyBytes: 100 })).toEqual({ evicted: 1 });

        expect(await store.body(oldest)).toBeNull();
        expect(await store.body(middle)).not.toBeNull();
        expect(await store.body(newest)).not.toBeNull();
        expect(await store.storedBodyBytes()).toBe(80);
      });

      it('keeps every body within both limits, and evicts nothing twice', async () => {
        await discard('a', 1 * DAY, 50);
        await discard('b', 0, 50);
        const limits = { now: NOW, maxAgeMs: 30 * DAY, maxBodyBytes: 100 };

        expect(await store.evictBodies(limits)).toEqual({ evicted: 0 });
        await discard('c', 0, 1);
        expect(await store.evictBodies(limits)).toEqual({ evicted: 1 });
        expect(await store.evictBodies(limits)).toEqual({ evicted: 0 });
        expect(await store.storedBodyBytes()).toBe(51);
      });

      it('never touches an entry without a body', async () => {
        const replay = await store.record(entry({ action: 'replay', at: new Date(NOW.getTime() - 400 * DAY), message: { body: null, properties: {}, headers: {} } }));

        expect(await store.evictBodies({ now: NOW, maxAgeMs: 30 * DAY, maxBodyBytes: 0 })).toEqual({ evicted: 0 });
        expect(await store.get(replay)).toMatchObject({ bodyExpiredAt: null, message: { bodyBytes: null } });
      });

      it('gives back a body byte for byte, whatever its bytes, and an empty one too', async () => {
        const everyByte = Buffer.from(Array.from({ length: 256 }, (_, i) => i));
        const full = await store.record(entry({ message: { body: everyByte, properties: {}, headers: {} } }));
        const empty = await store.record(entry({ message: { body: Buffer.alloc(0), properties: {}, headers: {} } }));

        expect((await store.body(full))?.equals(everyByte)).toBe(true);
        expect((await store.body(empty))?.length).toBe(0);
        expect((await store.get(empty))?.message?.bodyBytes).toBe(0);
      });

      it('keeps a body exactly at the age limit, and bodies that exactly fit the size limit', async () => {
        const atLimit = await discard('at-limit', 30 * DAY, 50);
        await discard('other', 0, 50);

        expect(await store.evictBodies({ now: NOW, maxAgeMs: 30 * DAY, maxBodyBytes: 100 })).toEqual({ evicted: 0 });
        expect(await store.body(atLimit)).not.toBeNull();
      });

      it('among bodies of the same moment, evicts the first written', async () => {
        const first = await discard('first', 0, 40);
        const second = await discard('second', 0, 40);

        expect(await store.evictBodies({ now: NOW, maxAgeMs: 30 * DAY, maxBodyBytes: 50 })).toEqual({ evicted: 1 });

        expect(await store.body(first)).toBeNull();
        expect(await store.body(second)).not.toBeNull();
      });

      it('keeps the mark of the eviction that came first, and evicts each body once when two run together', async () => {
        const old = await discard('old', 31 * DAY, 10);
        const limits = { maxAgeMs: 30 * DAY, maxBodyBytes: NO_SIZE_LIMIT };

        const [one, other] = await Promise.all([store.evictBodies({ now: NOW, ...limits }), store.evictBodies({ now: NOW, ...limits })]);
        expect(one.evicted + other.evicted).toBe(1);

        expect(await store.evictBodies({ now: after(DAY), ...limits })).toEqual({ evicted: 0 });
        expect((await store.get(old))?.bodyExpiredAt).toEqual(NOW);
      });

      it('keeps a size limit and a total beyond what 32 bits hold', async () => {
        const big = 5 * 1024 ** 3;
        await discard('small', 0, 10);

        expect(await store.evictBodies({ now: NOW, maxAgeMs: 30 * DAY, maxBodyBytes: big })).toEqual({ evicted: 0 });
        expect(await store.storedBodyBytes()).toBe(10);
      });

      it('reports no bytes when no body is stored', async () => {
        expect(await store.storedBodyBytes()).toBe(0);
      });
    });

    describe('Replay Rule state', () => {
      const KEY = 'local/transient-payments';
      const pass = (n: number): RulePass => ({
        id: `pass-${n}`,
        at: new Date(Date.UTC(2026, 9, 1, 0, n)).toISOString(),
        status: 'ran',
        summary: { held: n, replayed: 1, moved: 2, usedUp: 3, notDue: 4, noMatch: 5, cannotReplay: 6, failed: 7 },
        reason: null,
      });

      it('starts a rule as declared, and keeps the stored state after that, across a restart', async () => {
        expect(await store.ruleState.state(KEY)).toBeNull();
        expect(await store.ruleState.ensure(KEY, true)).toEqual({ paused: true, pausedReason: null, pausedBy: null, pausedAt: null });
        await store.ruleState.resume(KEY, ruleEntry('rule_resume'));

        await reopen();

        expect((await store.ruleState.ensure(KEY, true)).paused).toBe(false);
        expect(await store.ruleState.state('local/never-started')).toBeNull();
        expect((await store.ruleState.ensure('local/runs', false)).paused).toBe(false);
      });

      it('settles on one state when a rule is started by many calls at once', async () => {
        const states = await Promise.all(Array.from({ length: 10 }, () => store.ruleState.ensure(KEY, true)));
        expect(states.every((s) => s.paused)).toBe(true);
      });

      it('remembers why, by whom and when a rule was paused, until it runs again', async () => {
        await store.ruleState.pause(KEY, { reason: 'stop', by: 'ana', at: AT }, ruleEntry('rule_pause'));
        expect(await store.ruleState.state(KEY)).toEqual({ paused: true, pausedReason: 'stop', pausedBy: 'ana', pausedAt: AT.toISOString() });

        await store.ruleState.resume(KEY, ruleEntry('rule_resume'));
        expect(await store.ruleState.state(KEY)).toEqual({ paused: false, pausedReason: null, pausedBy: null, pausedAt: null });
      });

      it('writes the Audit Entry of a pause and of a resume, done, with the state', async () => {
        await store.ruleState.pause(KEY, { reason: 'stop', by: 'ana', at: AT }, ruleEntry('rule_pause'));
        await store.ruleState.resume(KEY, ruleEntry('rule_resume'));

        const entries = await store.list();
        expect(entries.map((e) => [e.action, e.outcome, e.rule])).toEqual([
          ['rule_resume', 'done', 'r'],
          ['rule_pause', 'done', 'r'],
        ]);
      });

      it('changes nothing on a pause or a resume whose Audit Entry cannot be written', async () => {
        const unwritable = { operator: { id: null as unknown as string, displayName: 'ana' } };
        await store.ruleState.ensure(KEY, false);
        await expect(store.ruleState.pause(KEY, { reason: 'stop', by: 'ana', at: AT }, ruleEntry('rule_pause', unwritable))).rejects.toThrow();
        expect((await store.ruleState.state(KEY))!.paused).toBe(false);

        const died = await store.record(entry({ action: 'replay', rule: 'r', messageId: 'died' }));
        const rule = { profile: 'local', name: 'r' };
        expect(await store.ruleState.countDiedAgain(KEY, rule, [died], AT, new Date(0))).toBe(1);
        await store.ruleState.pause(KEY, { reason: 'stop', by: 'ana', at: AT }, ruleEntry('rule_pause'));
        await expect(store.ruleState.resume(KEY, ruleEntry('rule_resume', unwritable))).rejects.toThrow();
        expect((await store.ruleState.state(KEY))!.paused).toBe(true);
        expect(await store.ruleState.countDiedAgain(KEY, rule, [], AT, new Date(0))).toBe(1);
        expect((await store.list()).filter((e) => e.action === 'rule_resume')).toEqual([]);
      });

      it(`keeps the last ${PASS_HISTORY} passes of a rule, newest first, and a skipped pass without counts`, async () => {
        for (let n = 1; n <= PASS_HISTORY + 5; n++) await store.ruleState.recordPass(KEY, pass(n));
        const skipped: RulePass = { id: 'skipped', at: pass(59).at, status: 'skipped', summary: null, reason: 'held by ana' };
        await store.ruleState.recordPass(KEY, skipped);
        await store.ruleState.recordPass('local/other', pass(1));

        const passes = await store.ruleState.passes(KEY);
        expect(passes).toHaveLength(PASS_HISTORY);
        expect(passes[0]).toEqual(skipped);
        expect(passes[1]).toEqual(pass(PASS_HISTORY + 5));
        expect(passes.at(-1)).toEqual(pass(7));
        expect(await store.ruleState.passes('local/other')).toEqual([pass(1)]);
      });

      it('orders passes of the same moment by when they were recorded', async () => {
        await store.ruleState.recordPass(KEY, { ...pass(1), id: 'first' });
        await store.ruleState.recordPass(KEY, { ...pass(1), id: 'second' });
        expect((await store.ruleState.passes(KEY)).map((p) => p.id)).toEqual(['second', 'first']);
      });

      it('remembers when a message id was first seen, by rule', async () => {
        const t1 = AT;
        const t2 = after(60_000);
        expect(await store.ruleState.firstSeen(KEY, ['a'], t1)).toEqual(new Map([['a', t1]]));
        expect(await store.ruleState.firstSeen(KEY, ['a', 'b', 'b'], t2)).toEqual(
          new Map([
            ['a', t1],
            ['b', t2],
          ]),
        );
        expect(await store.ruleState.firstSeen(KEY, [], t2)).toEqual(new Map());
        expect(await store.ruleState.firstSeenAt(KEY, ['a', 'b', 'a', 'never'])).toEqual(
          new Map([
            ['a', t1],
            ['b', t2],
          ]),
        );
        expect(await store.ruleState.firstSeenAt(KEY, [])).toEqual(new Map());
        expect(await store.ruleState.firstSeenAt('local/other', ['a'])).toEqual(new Map());
      });

      it(`forgets the oldest first-seen times beyond ${FIRST_SEEN_LIMIT}`, async () => {
        await store.ruleState.firstSeen(KEY, ['a'], AT);
        const many = Array.from({ length: FIRST_SEEN_LIMIT }, (_, i) => `m-${i}`);

        await store.ruleState.firstSeen(KEY, many, after(DAY));

        expect(await store.ruleState.firstSeenAt(KEY, ['a', 'm-0'])).toEqual(new Map([['m-0', after(DAY)]]));
      });

      it("counts each Died Again Message whose last Audit Entry is the rule's once, within the window, until a resume clears it", async () => {
        const rule = { profile: 'local', name: 'transient-payments' };
        const of = (ruleName: string | null, profile = 'local') => store.record(entry({ action: 'replay', reason: null, rule: ruleName, profile }));
        const ours = [await of('transient-payments'), await of('transient-payments')];
        const others = [await of(null), await of('other-rule'), await of('transient-payments', 'staging')];
        const minutes = (n: number) => after(n * 60_000);
        const count = (ids: number[], now: number, windowMinutes = 60) =>
          store.ruleState.countDiedAgain(KEY, rule, ids, minutes(now), minutes(now - windowMinutes));

        expect(await count([ours[0]!, ...others], 0)).toBe(1);
        // Seen again on the next pass: still one.
        expect(await count([ours[0]!, ours[0]!, ours[1]!], 5)).toBe(2);
        // At 30 minutes, a 27-minute window leaves out the one first seen at 0 but keeps the one seen at 5.
        expect(await count([], 30, 27)).toBe(1);
        await store.ruleState.resume(KEY, ruleEntry('rule_resume'));
        expect(await count([], 31)).toBe(0);
      });
    });

    describe('depth history', () => {
      const QUEUE = { profile: 'local', vhost: '/', queue: 'orders.dlq' };
      const run = (at: number, ok = true): StoredSamplingRun => ({ at, ok, errorCode: ok ? null : 'broker_unreachable', intervalMs: 1000 });
      const sample = (at: number, depth: number, overrides: Partial<QueueSample> = {}): QueueSample => ({ vhost: '/', queue: 'orders.dlq', at, depth, estimatedArrivals: null, ...overrides });
      const stored = (at: number, depth: number, estimatedArrivals: number | null = null) => ({ at, depth, estimatedArrivals });

      it('reads a queue\'s Samples in a range, both ends included, oldest first', async () => {
        for (const at of [3000, 1000, 2000, 4000]) await store.history.recordRun('local', run(at), [sample(at, at / 1000)]);
        expect(await store.history.samples(QUEUE, 2000, 3000)).toEqual([stored(2000, 2), stored(3000, 3)]);
      });

      it('keeps a Sample\'s estimated arrivals', async () => {
        await store.history.recordRun('local', run(1000), [sample(1000, 1, { estimatedArrivals: 7 })]);
        expect(await store.history.latestSample(QUEUE)).toEqual(stored(1000, 1, 7));
      });

      it('finds the latest Sample, or the latest before a time', async () => {
        await store.history.recordRun('local', run(1000), [sample(1000, 1)]);
        await store.history.recordRun('local', run(2000), [sample(2000, 2)]);
        expect(await store.history.latestSample(QUEUE)).toEqual(stored(2000, 2));
        expect(await store.history.latestSample(QUEUE, 2000)).toEqual(stored(1000, 1));
        expect(await store.history.latestSample(QUEUE, 1000)).toBeNull();
      });

      it('keeps queues, vhosts and Broker Profiles apart', async () => {
        await store.history.recordRun('local', run(1000), [sample(1000, 1), sample(1000, 2, { queue: 'other.dlq' }), sample(1000, 3, { vhost: 'v2' })]);
        await store.history.recordRun('staging', run(1000), [sample(1000, 4)]);
        expect(await store.history.samples(QUEUE, 0, 5000)).toEqual([stored(1000, 1)]);
        expect(await store.history.samples({ ...QUEUE, queue: 'other.dlq' }, 0, 5000)).toEqual([stored(1000, 2)]);
        expect(await store.history.samples({ ...QUEUE, vhost: 'v2' }, 0, 5000)).toEqual([stored(1000, 3)]);
        expect(await store.history.samples({ ...QUEUE, profile: 'staging' }, 0, 5000)).toEqual([stored(1000, 4)]);
      });

      it('takes a second run of the same moment over the first', async () => {
        await store.history.recordRun('local', run(1000, false), [sample(1000, 1)]);
        await store.history.recordRun('local', run(1000), [sample(1000, 2)]);
        expect(await store.history.samples(QUEUE, 0, 5000)).toEqual([stored(1000, 2)]);
        expect(await store.history.runsAround('local', 0, 5000)).toEqual([run(1000)]);
      });

      it('answers runs from the last good run before a range to the first good run after it', async () => {
        const runs = [run(500), run(1000), run(2000, false), run(3000), run(4000, false), run(5000), run(6000)];
        for (const r of runs) await store.history.recordRun('local', r, []);
        expect(await store.history.runsAround('local', 2500, 3500)).toEqual(runs.slice(1, 6));
      });

      it('answers every run on the side of a range that has no good run', async () => {
        const runs = [run(1000, false), run(2000, false), run(3000), run(4000, false)];
        for (const r of runs) await store.history.recordRun('local', r, []);
        expect(await store.history.runsAround('local', 1500, 3500)).toEqual(runs);
        expect(await store.history.runsAround('other', 0, 5000)).toEqual([]);
      });

      it('finds the latest run and the latest good run', async () => {
        expect(await store.history.lastRuns('local')).toEqual({ last: null, lastOk: null });
        await store.history.recordRun('local', run(1000), []);
        await store.history.recordRun('local', run(2000, false), []);
        expect(await store.history.lastRuns('local')).toEqual({ last: run(2000, false), lastOk: run(1000) });
        expect(await store.history.lastGoodRunBefore('local', 2000)).toBe(1000);
        expect(await store.history.lastGoodRunBefore('local', 1000)).toBeNull();
      });

      it('keeps a run without an interval', async () => {
        await store.history.recordRun('local', { ...run(1000), intervalMs: null }, []);
        expect((await store.history.lastRuns('local')).last?.intervalMs).toBeNull();
      });

      it('removes Samples and runs older than a time, and nothing else', async () => {
        await store.history.recordRun('local', run(1000), [sample(1000, 1), sample(1000, 2, { queue: 'other.dlq' })]);
        await store.history.recordRun('local', run(2000), [sample(2000, 3)]);
        expect(await store.history.removeOlderThan(2000)).toEqual({ samples: 2, runs: 1 });
        expect(await store.history.samples(QUEUE, 0, 5000)).toEqual([stored(2000, 3)]);
        expect(await store.history.runsAround('local', 0, 5000)).toEqual([run(2000)]);
      });

      describe('Messages taken out', () => {
        const at = AT.getTime();
        const taken = async (overrides: Partial<NewAuditEntry>, outcome: 'done' | 'failed' = 'done') => {
          const id = await store.record(entry(overrides));
          await store.setOutcome(id, outcome);
        };

        it('counts what was carried out, after one time and up to another', async () => {
          await taken({ at: new Date(at) });
          await taken({ at: new Date(at + 1), action: 'replay' });
          await taken({ at: new Date(at + 2), action: 'move' });
          await taken({ at: new Date(at + 3) });
          expect(await store.history.takenOut(QUEUE, at, at + 2)).toBe(2);
        });

        it('does not count an export, a Restore, a failed step, a step in progress or another queue', async () => {
          await taken({ action: 'export' });
          await taken({ action: 'restore' });
          await taken({}, 'failed');
          await store.record(entry());
          await taken({ queue: 'other.dlq' });
          await taken({ vhost: 'v2' });
          await taken({ profile: 'staging' });
          expect(await store.history.takenOut(QUEUE, at - 1, at)).toBe(0);
        });

        it('answers each Apply and Rule Pass with its counts, oldest first', async () => {
          await taken({ at: new Date(at + 2000), checkoutId: 'later', rule: 'db-timeouts', action: 'replay', operator: { id: 'rule', displayName: 'Replay rule db-timeouts' } });
          await taken({ at: new Date(at), checkoutId: 'earlier' });
          await taken({ at: new Date(at + 1000), checkoutId: 'earlier' });
          await taken({ at: new Date(at + 500), checkoutId: 'earlier', action: 'move' });
          await taken({ at: new Date(at), checkoutId: null });

          expect(await store.history.takeOuts(QUEUE, at, at + 2000)).toEqual([
            { checkoutId: 'earlier', at: at + 1000, operator: 'ana@example.com', rule: null, counts: { discard: 2, replay: 0, move: 1 } },
            { checkoutId: 'later', at: at + 2000, operator: 'Replay rule db-timeouts', rule: 'db-timeouts', counts: { discard: 0, replay: 1, move: 0 } },
          ]);
          expect(await store.history.takeOuts(QUEUE, at + 2001, at + 3000)).toEqual([]);
        });
      });
    });

    describe('notifications', () => {
      const delivery = (overrides: Partial<NewNotificationDelivery> = {}): NewNotificationDelivery => ({
        at: AT,
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
        ...overrides,
      });

      it('answers an outcome as it will read it back', async () => {
        const recorded = await store.notifications.record(delivery({ outcome: 'failed', httpStatus: null, error: 'timed out', attempts: 3, replayRule: 'retry' }));
        expect(recorded).toEqual({ ...delivery({ outcome: 'failed', httpStatus: null, error: 'timed out', attempts: 3, replayRule: 'retry' }), id: recorded.id, at: AT.toISOString() });
        expect(await store.notifications.recent()).toEqual([recorded]);
      });

      it('keeps a test notification, which belongs to no Broker Profile', async () => {
        const recorded = await store.notifications.record(delivery({ test: true, profile: null, vhost: null, queue: null }));
        expect(await store.notifications.recent()).toEqual([recorded]);
      });

      it('answers the latest first, 100 unless told otherwise', async () => {
        for (let i = 0; i < 101; i++) await store.notifications.record(delivery({ at: after(i), alertId: `a-${i}` }));
        const recent = await store.notifications.recent();
        expect(recent).toHaveLength(100);
        expect(recent[0]?.alertId).toBe('a-100');
        expect(recent.at(-1)?.alertId).toBe('a-1');
        expect((await store.notifications.recent(2)).map((d) => d.alertId)).toEqual(['a-100', 'a-99']);
      });

      it('orders outcomes of the same moment by when they were recorded', async () => {
        await store.notifications.record(delivery({ alertId: 'first' }));
        await store.notifications.record(delivery({ alertId: 'second' }));
        expect((await store.notifications.recent()).map((d) => d.alertId)).toEqual(['second', 'first']);
      });

      it('narrows to a scope before the limit counts', async () => {
        await store.notifications.record(delivery({ alertId: 'local', at: after(0) }));
        await store.notifications.record(delivery({ alertId: 'staging', profile: 'staging', at: after(1) }));
        await store.notifications.record(delivery({ alertId: 'test', test: true, profile: null, vhost: null, queue: null, at: after(2) }));
        const ids = async (limit: number, tests: boolean, profiles: { only: string[] } | { except: string[] }) =>
          (await store.notifications.recent(limit, { profiles, tests })).map((d) => d.alertId);

        expect(await ids(1, false, { only: ['local'] })).toEqual(['local']);
        expect(await ids(10, false, { except: ['local'] })).toEqual(['staging']);
        expect(await ids(10, false, { except: [] })).toEqual(['staging', 'local']);
        expect(await ids(10, false, { only: [] })).toEqual([]);
        expect(await ids(10, true, { only: [] })).toEqual(['test']);
        expect(await ids(10, true, { only: ['staging'] })).toEqual(['test', 'staging']);
      });

      it('shows an outcome of no Broker Profile that is no test notification to no scope', async () => {
        const recorded = await store.notifications.record(delivery({ profile: null, vhost: null, queue: null }));
        expect(await store.notifications.recent()).toEqual([recorded]);
        expect(await store.notifications.recent(10, { profiles: { except: [] }, tests: true })).toEqual([]);
        expect(await store.notifications.recent(10, { profiles: { except: ['local'] }, tests: true })).toEqual([]);
      });

      it('removes the outcomes from before a time and says how many', async () => {
        await store.notifications.record(delivery({ alertId: 'old', at: after(-1) }));
        await store.notifications.record(delivery({ alertId: 'kept', at: AT }));
        expect(await store.notifications.removeOlderThan(AT)).toBe(1);
        expect((await store.notifications.recent()).map((d) => d.alertId)).toEqual(['kept']);
      });
    });

    describe('Alerts', () => {
      const firing: AlertMemory['alerts'][number] = {
        alertId: 'a-1',
        rule: 'deep',
        vhost: '/',
        queue: 'orders.dlq',
        status: 'firing',
        condition: 'depthAbove',
        value: 5.5,
        threshold: 3,
        since: 1000,
        lastNotifiedAt: 1000,
        falseSince: null,
        replayRule: null,
        reason: null,
      };
      const arrivals: AlertMemory['arrivals'][number] = { vhost: '/', queue: 'orders.dlq', unsettled: 2, recent: [{ at: 1000, count: 2 }] };
      const NOTHING: AlertMemory = { alerts: [], arrivals: [] };

      it('remembers nothing of a profile at first', async () => {
        expect(await store.alerts.load('local')).toEqual(NOTHING);
      });

      it('saves and loads what is remembered, across a restart', async () => {
        const memory = { alerts: [firing], arrivals: [arrivals] };
        await store.alerts.save('local', memory);

        await reopen();

        expect(await store.alerts.load('local')).toEqual(memory);
      });

      it('keeps an Alert of no queue, and an Alert per Replay Rule', async () => {
        const stopped = { ...firing, alertId: 'a-2', rule: 'stopped', vhost: null, queue: null, condition: 'replayRulePaused', value: null, threshold: null, reason: 'automatic stop' } as const;
        const memory = {
          alerts: [
            { ...stopped, replayRule: 'one' },
            { ...stopped, alertId: 'a-3', replayRule: 'two' },
          ],
          arrivals: [],
        };
        await store.alerts.save('local', memory);
        expect(await store.alerts.load('local')).toEqual(memory);
      });

      it('orders Alerts by the bytes of their rule names, on any database locale', async () => {
        const named = (rule: string, alertId: string) => ({ ...firing, rule, alertId });
        await store.alerts.save('local', { alerts: [named('apple', 'a-1'), named('Zebra', 'a-2')], arrivals: [] });
        expect((await store.alerts.load('local')).alerts.map((a) => a.rule)).toEqual(['Zebra', 'apple']);
      });

      it('replaces what is remembered of the profile, and only that profile', async () => {
        await store.alerts.save('local', { alerts: [firing], arrivals: [arrivals] });
        await store.alerts.save('staging', { alerts: [firing], arrivals: [arrivals] });

        const resolved = { ...firing, alertId: 'a-9', rule: 'other' };
        await store.alerts.save('local', { alerts: [resolved], arrivals: [] });

        expect(await store.alerts.load('local')).toEqual({ alerts: [resolved], arrivals: [] });
        expect(await store.alerts.load('staging')).toEqual({ alerts: [firing], arrivals: [arrivals] });
      });

      it('forgets the Alerts of rules no longer in the file, and all of profiles no longer in it', async () => {
        const kept = { ...firing, alertId: 'a-2', rule: 'kept' };
        await store.alerts.save('local', { alerts: [firing, kept], arrivals: [arrivals] });
        await store.alerts.save('gone', { alerts: [firing], arrivals: [arrivals] });

        await store.alerts.keepOnly(new Map([['local', ['kept']]]));

        expect(await store.alerts.load('local')).toEqual({ alerts: [kept], arrivals: [arrivals] });
        expect(await store.alerts.load('gone')).toEqual(NOTHING);
      });
    });

    describe('a call is one atomic unit of work', () => {
      it('leaves what was remembered of a profile when saving fails partway', async () => {
        const firing: AlertMemory['alerts'][number] = {
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
        };
        const before = { alerts: [firing], arrivals: [] };
        await store.alerts.save('local', before);

        // The same Alert twice: the old rows are gone and the first is in when the second is refused.
        await expect(store.alerts.save('local', { alerts: [{ ...firing, alertId: 'a-2' }, { ...firing, alertId: 'a-3' }], arrivals: [] })).rejects.toThrow();

        expect(await store.alerts.load('local')).toEqual(before);
      });

      it('records no sampling run when one of its Samples is refused', async () => {
        const run = { at: 1000, ok: true, errorCode: null, intervalMs: 1000 };
        const refused = { vhost: '/', queue: 'orders.dlq', at: 1000, depth: null as unknown as number, estimatedArrivals: null };

        await expect(store.history.recordRun('local', run, [refused])).rejects.toThrow();

        expect(await store.history.lastRuns('local')).toEqual({ last: null, lastOk: null });
      });

      it('still works after a call has been refused', async () => {
        const refused = { vhost: '/', queue: 'orders.dlq', at: 1000, depth: null as unknown as number, estimatedArrivals: null };
        await expect(store.history.recordRun('local', { at: 1000, ok: true, errorCode: null, intervalMs: 1000 }, [refused])).rejects.toThrow();

        const id = await store.record(entry());
        expect((await store.get(id))?.outcome).toBe('pending');
      });
    });

    describe('failures', () => {
      it('rejects rather than throws on a closed store, on every part of it', async () => {
        await store.close();
        const calls: Array<() => Promise<unknown>> = [
          () => store.record(entry()),
          () => store.setOutcome(1, 'done'),
          () => store.list(),
          () => store.evictBodies({ now: AT, maxAgeMs: 1, maxBodyBytes: 1 }),
          () => store.storedBodyBytes(),
          () => store.ruleState.ensure('local/rule', false),
          () => store.history.lastRuns('local'),
          () => store.notifications.recent(),
          () => store.alerts.load('local'),
        ];
        for (const call of calls) {
          let promise: Promise<unknown> | undefined;
          expect(() => {
            promise = call();
          }).not.toThrow();
          await expect(promise).rejects.toThrow();
        }
      });
    });

    describe('sessions', () => {
      const NOW = AT.getTime();
      const session = (overrides: Partial<StoredSession> = {}): StoredSession => ({
        operator: { id: 'sub-123', displayName: 'ana@example.com', email: 'ana@example.com', groups: ['ops'] },
        tokens: 'sealed-tokens',
        expiresAt: NOW + 1000,
        ...overrides,
      });

      it('answers a session as it was added', async () => {
        await store.sessions.addSession('s-1', session(), NOW);
        expect(await store.sessions.session('s-1', NOW)).toEqual(session());
      });

      it('answers null for a session it does not have', async () => {
        expect(await store.sessions.session('nobody', NOW)).toBeNull();
      });

      it('no longer answers a session once it has expired', async () => {
        await store.sessions.addSession('s-1', session(), NOW);
        expect(await store.sessions.session('s-1', NOW + 999)).not.toBeNull();
        expect(await store.sessions.session('s-1', NOW + 1000)).toBeNull();
      });

      it('removes a session, and removing it again does nothing', async () => {
        await store.sessions.addSession('s-1', session(), NOW);
        await store.sessions.addSession('s-2', session(), NOW);
        await store.sessions.removeSession('s-1');
        await store.sessions.removeSession('s-1');
        expect(await store.sessions.session('s-1', NOW)).toBeNull();
        expect(await store.sessions.session('s-2', NOW)).not.toBeNull();
      });

      it("replaces a session's tokens and nothing else", async () => {
        await store.sessions.addSession('s-1', session(), NOW);
        await store.sessions.setTokens('s-1', 'rotated');
        expect(await store.sessions.session('s-1', NOW)).toEqual(session({ tokens: 'rotated' }));
      });

      it('does not bring a removed session back when its tokens are set', async () => {
        await store.sessions.setTokens('s-1', 'rotated');
        expect(await store.sessions.session('s-1', NOW)).toBeNull();
      });

      it('hands a sign-in in progress to one caller only', async () => {
        await store.sessions.addSignIn('l-1', { sealed: 'sealed-login', expiresAt: NOW + 1000 }, NOW);
        const taken = await Promise.all([store.sessions.takeSignIn('l-1', NOW), store.sessions.takeSignIn('l-1', NOW)]);
        expect(taken.sort()).toEqual(['sealed-login', null].sort());
        expect(await store.sessions.takeSignIn('l-1', NOW)).toBeNull();
      });

      it('does not hand over a sign-in that has expired', async () => {
        await store.sessions.addSignIn('l-1', { sealed: 'sealed-login', expiresAt: NOW + 1000 }, NOW);
        expect(await store.sessions.takeSignIn('l-1', NOW + 1000)).toBeNull();
      });

      it('leaves others alone when something new is added past their expiry', async () => {
        await store.sessions.addSession('old', session(), NOW);
        await store.sessions.addSession('live', session({ expiresAt: NOW + 5000 }), NOW);
        await store.sessions.addSession('new', session({ expiresAt: NOW + 5000 }), NOW + 2000);
        expect(await store.sessions.session('live', NOW + 2000)).not.toBeNull();
        expect(await store.sessions.session('old', NOW)).toBeNull();
      });
    });

    describe('closing', () => {
      it('answers a ping while it is open', async () => {
        await expect(store.ping()).resolves.toBeUndefined();
      });

      it('closes more than once', async () => {
        await store.close();
        await expect(store.close()).resolves.toBeUndefined();
      });
    });

    describe('the leader lease', () => {
      const NOW = AT.getTime();
      const LEASE = 15_000;
      const lease = () => store.leaderLease;
      const oldDiscard = () => store.record(entry({ at: new Date(NOW - 2 * DAY), message: { body: Buffer.from('b'), properties: {}, headers: {} } }));
      const evict = (fence: LeaseFence) => store.evictBodies({ now: new Date(NOW), maxAgeMs: DAY, maxBodyBytes: 1000 }, fence);

      it('goes to the first to claim it, and to nobody else while it lasts', async () => {
        expect(await lease().claim('a', NOW, LEASE)).toMatchObject({ holder: 'a', expiresAt: NOW + LEASE });
        expect(await lease().claim('b', NOW + LEASE - 1, LEASE)).toBeNull();
      });

      it('is renewed by its holder, in the same term', async () => {
        const first = await lease().claim('a', NOW, LEASE);
        const renewed = await lease().claim('a', NOW + 5_000, LEASE);
        expect(renewed).toEqual({ holder: 'a', term: first!.term, expiresAt: NOW + 5_000 + LEASE });
        expect(await lease().claim('b', NOW + LEASE + 1, LEASE)).toBeNull();
      });

      it('goes to another once it has expired, in a later term', async () => {
        const first = await lease().claim('a', NOW, LEASE);
        const taken = await lease().claim('b', NOW + LEASE, LEASE);
        expect(taken!.holder).toBe('b');
        expect(taken!.term).toBeGreaterThan(first!.term);
        expect(await lease().claim('a', NOW + LEASE + 1, LEASE)).toBeNull();
      });

      it('gives one of many claiming at once the lease', async () => {
        const claims = await Promise.all(['a', 'b', 'c', 'd'].map((holder) => lease().claim(holder, NOW, LEASE)));
        expect(claims.filter(Boolean)).toHaveLength(1);
      });

      it('is free for another at once when its holder gives it up, in a later term', async () => {
        const first = await lease().claim('a', NOW, LEASE);
        await lease().release('a');
        const taken = await lease().claim('b', NOW + 1, LEASE);
        expect(taken!.term).toBeGreaterThan(first!.term);
      });

      it('stays with its holder when another gives it up', async () => {
        await lease().claim('a', NOW, LEASE);
        await lease().release('b');
        expect(await lease().claim('b', NOW + 1, LEASE)).toBeNull();
      });

      it('lets a write through for the lease as it is held', async () => {
        const fence = (await lease().claim('a', NOW, LEASE))!;
        await oldDiscard();
        expect(await evict(fence)).toEqual({ evicted: 1 });
        expect(await store.history.removeOlderThan(NOW, fence)).toEqual({ samples: 0, runs: 0 });
        expect(await store.notifications.removeOlderThan(new Date(NOW), fence)).toBe(0);
      });

      it('refuses a write for a lease another has taken since, and does none of it', async () => {
        const stale = (await lease().claim('a', NOW, LEASE))!;
        await lease().claim('b', NOW + LEASE, LEASE);
        const id = await oldDiscard();
        await store.history.recordRun('p', { at: NOW - DAY, ok: true, errorCode: null, intervalMs: 1000 }, []);

        await expect(evict(stale)).rejects.toBeInstanceOf(LeaderLeaseLost);
        await expect(store.history.removeOlderThan(NOW, stale)).rejects.toBeInstanceOf(LeaderLeaseLost);
        await expect(store.notifications.removeOlderThan(new Date(NOW), stale)).rejects.toBeInstanceOf(LeaderLeaseLost);

        expect(await store.body(id)).not.toBeNull();
        expect((await store.history.lastRuns('p')).last).not.toBeNull();
      });

      it('records a sampling run for the lease as it is held, and refuses one for a lease another has taken since, recording none of it', async () => {
        const ref = { profile: 'p', vhost: '/', queue: 'q' };
        const run = (at: number) => ({ at, ok: true, errorCode: null, intervalMs: 1000 });
        const sample = (at: number) => ({ vhost: '/', queue: 'q', at, depth: 1, estimatedArrivals: null });
        const held = (await lease().claim('a', NOW, LEASE))!;
        await store.history.recordRun('p', run(NOW), [sample(NOW)], held);
        await lease().claim('b', NOW + LEASE, LEASE);

        await expect(store.history.recordRun('p', run(NOW + 1), [sample(NOW + 1)], held)).rejects.toBeInstanceOf(LeaderLeaseLost);

        expect((await store.history.lastRuns('p')).last!.at).toBe(NOW);
        expect((await store.history.samples(ref, NOW, NOW + 1)).map((s) => s.at)).toEqual([NOW]);
      });

      it('refuses a write for a lease given up', async () => {
        const given = (await lease().claim('a', NOW, LEASE))!;
        await lease().release('a');
        await expect(evict(given)).rejects.toBeInstanceOf(LeaderLeaseLost);
      });

      it('refuses a write when the same holder is back in a later term', async () => {
        const before = (await lease().claim('a', NOW, LEASE))!;
        await lease().release('a');
        await lease().claim('a', NOW + 1, LEASE);
        await expect(evict(before)).rejects.toBeInstanceOf(LeaderLeaseLost);
      });
    });

    describe('a store newer than the binary', () => {
      it('refuses to open it, and leaves it refused', async () => {
        await store.record(entry());
        await store.close();
        await opened.makeNewer();

        await expect(opened.reopen()).rejects.toBeInstanceOf(ConfigError);
        await expect(opened.reopen()).rejects.toThrow(/newer than this version/);
      });
    });
  });
}
