// Retention of Discarded Message bodies (#10): Audit Entries stay forever;
// only bodies are evicted, oldest first, past the age limit or once the
// stored bodies exceed the size limit. An evicted entry says "body expired".
import { describe, expect, it } from 'vitest';
import { AuditStore, type NewAuditEntry } from '../../src/server/audit/store.js';

const DAY = 24 * 60 * 60 * 1000;
const NOW = new Date('2026-10-23T12:00:00Z');

function discard(messageId: string, ageMs: number, bodyBytes: number): NewAuditEntry {
  return {
    at: new Date(NOW.getTime() - ageMs),
    operator: { id: 'ana', displayName: 'ana' },
    brokerUser: 'volveran-admin',
    profile: 'local',
    vhost: '/',
    queue: 'orders.dlq',
    messageId,
    action: 'discard',
    reason: 'bad payload',
    destination: null,
    checkoutId: 'c-1',
    message: { body: Buffer.alloc(bodyBytes, 'x'), properties: { messageId }, headers: {} },
  };
}

const NO_SIZE_LIMIT = Number.MAX_SAFE_INTEGER;

describe('evicting Discarded Message bodies', () => {
  it('evicts the bodies older than the age limit and keeps their Audit Entries, marked body expired', () => {
    const store = new AuditStore();
    const old = store.record(discard('old', 31 * DAY, 10));
    const young = store.record(discard('young', 29 * DAY, 10));

    const result = store.evictBodies({ now: NOW, maxAgeMs: 30 * DAY, maxBodyBytes: NO_SIZE_LIMIT });

    expect(result).toEqual({ evicted: 1 });
    expect(store.body(old)).toBeNull();
    expect(store.get(old)).toMatchObject({ messageId: 'old', bodyExpiredAt: NOW, message: { bodyBytes: 10 } });
    expect(store.body(young)).toEqual(Buffer.alloc(10, 'x'));
    expect(store.get(young)?.bodyExpiredAt).toBeNull();
    store.close();
  });

  it('evicts the oldest bodies until the rest fit in the size limit', () => {
    const store = new AuditStore();
    const oldest = store.record(discard('oldest', 3 * DAY, 40));
    const middle = store.record(discard('middle', 2 * DAY, 40));
    const newest = store.record(discard('newest', 1 * DAY, 40));

    expect(store.evictBodies({ now: NOW, maxAgeMs: 30 * DAY, maxBodyBytes: 100 })).toEqual({ evicted: 1 });

    expect([oldest, middle, newest].map((id) => store.get(id)?.bodyExpiredAt !== null)).toEqual([true, false, false]);
    expect(store.storedBodyBytes()).toBe(80);
    store.close();
  });

  it('keeps every body within both limits, and evicts nothing twice', () => {
    const store = new AuditStore();
    store.record(discard('a', 1 * DAY, 50));
    store.record(discard('b', 0, 50));
    const limits = { now: NOW, maxAgeMs: 30 * DAY, maxBodyBytes: 100 };

    expect(store.evictBodies(limits)).toEqual({ evicted: 0 });
    store.record(discard('c', 0, 1));
    expect(store.evictBodies(limits)).toEqual({ evicted: 1 });
    expect(store.evictBodies(limits)).toEqual({ evicted: 0 });
    expect(store.storedBodyBytes()).toBe(51);
    store.close();
  });

  it('never touches Audit Entries without a body (Replay, Move, Restore)', () => {
    const store = new AuditStore();
    const replay = store.record({
      ...discard('r', 400 * DAY, 0),
      action: 'replay',
      reason: null,
      message: { body: null, properties: {}, headers: {} },
    });

    expect(store.evictBodies({ now: NOW, maxAgeMs: 30 * DAY, maxBodyBytes: 0 })).toEqual({ evicted: 0 });
    expect(store.get(replay)).toMatchObject({ bodyExpiredAt: null, message: { bodyBytes: null } });
    store.close();
  });
});
