// The audit store: Audit Entries in SQLite, with the full copy of a Discarded
// Message kept apart from the entry so retention can evict bodies only.
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { AUDIT_DB_FILE, AuditStore, type NewAuditEntry } from '../../src/server/audit/store.js';

function entry(overrides: Partial<NewAuditEntry> = {}): NewAuditEntry {
  return {
    at: new Date('2026-10-01T12:00:00Z'),
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

describe('AuditStore', () => {
  let store: AuditStore | undefined;
  let dir: string | undefined;
  afterEach(async () => {
    store?.close();
    store = undefined;
    if (dir) await rm(dir, { recursive: true, force: true });
    dir = undefined;
  });

  it('records a pending Audit Entry with the Operator, the broker user and the reason, then its outcome', () => {
    store = new AuditStore();
    const id = store.record(entry());

    expect(store.get(id)).toMatchObject({
      id,
      at: new Date('2026-10-01T12:00:00Z'),
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

    store.setOutcome(id, 'failed', 'channel closed');
    expect(store.get(id)).toMatchObject({ outcome: 'failed', outcomeReason: 'channel closed' });
  });

  it('keeps a byte-identical copy of the Message, with properties and headers exactly as amqplib decoded them', () => {
    store = new AuditStore();
    const body = Buffer.from([0, 1, 2, 254, 255]);
    const headers = {
      raw: Buffer.from([9, 8]),
      big: 12345678901234567890n,
      '$odd': 'dollar key',
      'x-death': [{ queue: 'orders.work', reason: 'rejected', count: 1, 'routing-keys': ['orders.created'] }],
    };
    const id = store.record(
      entry({ message: { body, properties: { messageId: 'm-1', contentType: 'application/octet-stream', timestamp: 1792139557 }, headers } }),
    );

    const stored = store.get(id)!;
    expect(stored.message).toEqual({
      properties: { messageId: 'm-1', contentType: 'application/octet-stream', timestamp: 1792139557 },
      headers,
      bodyBytes: 5,
    });
    expect(store.body(id)!.equals(body)).toBe(true);
  });

  it('records where a Message went and its original headers, without a body (Replay, Move)', () => {
    store = new AuditStore();
    const id = store.record(
      entry({
        action: 'move',
        reason: null,
        destination: { exchange: '', routingKey: 'triage.manual', queue: 'triage.manual' },
        message: { body: null, properties: { messageId: 'm-1' }, headers: { tenant: 'acme' } },
      }),
    );

    expect(store.get(id)).toMatchObject({
      destination: { exchange: '', routingKey: 'triage.manual', queue: 'triage.manual' },
      message: { properties: { messageId: 'm-1' }, headers: { tenant: 'acme' }, bodyBytes: null },
    });
    expect(store.body(id)).toBeNull();
  });

  it('searches Audit Entries by queue, message_id, action and date, newest first, without bodies', () => {
    store = new AuditStore();
    const s = store;
    const discardA = s.record(entry({ messageId: 'a', at: new Date('2026-10-01T10:00:00Z') }));
    const discardB = s.record(entry({ messageId: 'b', at: new Date('2026-10-02T10:00:00Z') }));
    const movedA = s.record(
      entry({
        messageId: 'a',
        action: 'move',
        reason: null,
        at: new Date('2026-10-03T10:00:00Z'),
        destination: { exchange: '', routingKey: 'triage.manual', queue: 'triage.manual' },
      }),
    );
    const otherQueue = s.record(entry({ messageId: 'a', queue: 'payments.dlq', at: new Date('2026-10-04T10:00:00Z') }));
    const ids = (query: Parameters<AuditStore['list']>[0]) => s.list(query).map((e) => e.id);

    expect(ids({})).toEqual([otherQueue, movedA, discardB, discardA]);
    expect(ids({ messageId: 'a' })).toEqual([otherQueue, movedA, discardA]);
    expect(ids({ queue: 'orders.dlq' })).toEqual([movedA, discardB, discardA]);
    // A queue a Message was sent to counts as well.
    expect(ids({ queue: 'triage.manual' })).toEqual([movedA]);
    expect(ids({ action: 'move' })).toEqual([movedA]);
    expect(ids({ checkoutId: 'c-1', action: 'discard', queue: 'orders.dlq' })).toEqual([discardB, discardA]);
    expect(ids({ from: new Date('2026-10-02T00:00:00Z'), to: new Date('2026-10-03T23:59:59Z') })).toEqual([movedA, discardB]);
    expect(ids({ limit: 2 })).toEqual([otherQueue, movedA]);
  });

  it('keeps Audit Entries in its data directory across reopening', async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'audit-store-'));
    const first = new AuditStore(dir);
    const id = first.record(entry({ message: { body: Buffer.from('hello'), properties: {}, headers: {} } }));
    first.close();

    store = new AuditStore(dir);
    expect(store.get(id)).toMatchObject({ messageId: 'm-1', outcome: 'pending' });
    expect(store.body(id)!.toString()).toBe('hello');
  });
  it('records the replay id of a Replay or Move and finds entries by it', () => {
    store = new AuditStore();
    const discarded = store.record(entry());
    const moved = store.record(entry({ action: 'move', reason: null, replayId: 'r-1' }));
    store.record(entry({ action: 'replay', reason: null, replayId: 'r-2' }));

    expect(store.get(discarded)?.replayId).toBeNull();
    expect(store.get(moved)?.replayId).toBe('r-1');
    expect(store.list({ replayId: 'r-1' }).map((e) => e.id)).toEqual([moved]);
    expect(store.list({ replayId: 'nope' })).toEqual([]);
  });

  it('records the Operator\'s role, and reads entries written before roles existed back with none', async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'audit-store-'));
    new AuditStore(dir).close();
    // Turn it back into a version 3 store holding one entry.
    const db = new DatabaseSync(path.join(dir, AUDIT_DB_FILE));
    // Newest first: v10 (#64 rule state), v8 (#63 rule), v7 (#56 rate), v6 (#44 export), v5 (#45 approver), v4 (#38 role).
    db.exec(`DROP TABLE replay_rule_state; DROP TABLE replay_rule_passes; DROP TABLE replay_rule_first_seen;
             DROP INDEX audit_entries_rule; ALTER TABLE audit_entries DROP COLUMN rule; ALTER TABLE audit_entries DROP COLUMN rule_pass_id;
             ALTER TABLE audit_entries DROP COLUMN rate;
             ALTER TABLE audit_entries DROP COLUMN filter; ALTER TABLE audit_entries DROP COLUMN message_count;
             ALTER TABLE audit_entries DROP COLUMN approver_id; ALTER TABLE audit_entries DROP COLUMN approver_name;
             ALTER TABLE audit_entries DROP COLUMN operator_role; PRAGMA user_version = 3;`);
    db.exec(`INSERT INTO audit_entries (created_at, operator_id, operator_name, broker_user, profile, vhost, queue, action, outcome)
             VALUES (0, 'sub-1', 'ana', 'volveran-admin', 'local', '/', 'orders.dlq', 'replay', 'done')`);
    db.close();

    store = new AuditStore(dir);

    const id = store.record(entry({ role: 'operator' }));
    expect(store.get(id)?.role).toBe('operator');
    expect(store.list()[1]).toMatchObject({
      queue: 'orders.dlq',
      role: null,
      approverId: null,
      approverName: null,
      filter: null,
      messageCount: null,
      rate: null,
      rule: null,
      rulePassId: null,
    });
  });

  it('records the Replay Rule and Rule Pass that wrote an entry, and finds them by rule', () => {
    store = new AuditStore();
    const byRule = store.record(entry({ rule: 'db-timeouts', rulePassId: 'pass-1' }));
    const byPerson = store.record(entry());
    expect(store.get(byRule)).toMatchObject({ rule: 'db-timeouts', rulePassId: 'pass-1' });
    expect(store.get(byPerson)).toMatchObject({ rule: null, rulePassId: null });
    expect(store.list({ rule: 'db-timeouts' }).map((e) => e.id)).toEqual([byRule]);
  });

  it('records who approved an Apply, and no one when it needed no Approval', () => {
    store = new AuditStore();
    const approved = store.record(entry({ approver: { id: 'alan-sub', displayName: 'alan@example.com' } }));
    const alone = store.record(entry());
    expect(store.get(approved)).toMatchObject({ approverId: 'alan-sub', approverName: 'alan@example.com' });
    expect(store.get(alone)).toMatchObject({ approverId: null, approverName: null });
  });

  it('upgrades a store written before replay ids existed, keeping its entries', async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'audit-store-'));
    new AuditStore(dir).close();
    // Turn it back into a version 1 store holding one entry.
    const db = new DatabaseSync(path.join(dir, AUDIT_DB_FILE));
    // Newest first: v10 (#64), v8 (#63), v7 (#56), v6 (#44), v5 (#45), then v3 (#10), v2 (#8) and v4 (#38) as before.
    db.exec(`DROP TABLE replay_rule_state; DROP TABLE replay_rule_passes; DROP TABLE replay_rule_first_seen;
             DROP INDEX audit_entries_rule; ALTER TABLE audit_entries DROP COLUMN rule; ALTER TABLE audit_entries DROP COLUMN rule_pass_id;
             ALTER TABLE audit_entries DROP COLUMN rate;
             ALTER TABLE audit_entries DROP COLUMN filter; ALTER TABLE audit_entries DROP COLUMN message_count;
             ALTER TABLE audit_entries DROP COLUMN approver_id; ALTER TABLE audit_entries DROP COLUMN approver_name;
             DROP INDEX audit_entries_restore_of; DROP INDEX audit_entries_stored_bodies;
             ALTER TABLE audit_entries DROP COLUMN restore_of; ALTER TABLE audit_entries DROP COLUMN body_expired_at;
             DROP INDEX audit_entries_replay_id; ALTER TABLE audit_entries DROP COLUMN replay_id;
             ALTER TABLE audit_entries DROP COLUMN operator_role; PRAGMA user_version = 1;`);
    db.exec(`INSERT INTO audit_entries (created_at, operator_id, operator_name, broker_user, profile, vhost, queue, action, outcome)
             VALUES (0, 'sub-1', 'ana', 'volveran-admin', 'local', '/', 'orders.dlq', 'replay', 'done')`);
    db.close();

    store = new AuditStore(dir);

    expect(store.list()).toEqual([expect.objectContaining({ queue: 'orders.dlq', action: 'replay', replayId: null })]);
    const id = store.record(entry({ action: 'move', reason: null, replayId: 'r-9' }));
    expect(store.list({ replayId: 'r-9' }).map((e) => e.id)).toEqual([id]);
    // Versions 3 (#10), 4 (#38), 5 (#45) and 6 (#44) came along too.
    expect(store.list()[1]).toMatchObject({
      restoreOf: null,
      bodyExpiredAt: null,
      role: null,
      approverId: null,
      approverName: null,
      filter: null,
      messageCount: null,
    });
  });

  it('records an export with its filter and Message count, and no Message copy', () => {
    store = new AuditStore();
    const filter = [{ kind: 'header' as const, name: 'tenant', value: 'acme' }];
    const filtered = store.record(entry({ action: 'export', messageId: null, reason: null, filter, messageCount: 2 }));
    const all = store.record(entry({ action: 'export', messageId: null, reason: null, messageCount: 5 }));
    const discarded = store.record(entry());

    expect(store.get(filtered)).toMatchObject({ action: 'export', filter, messageCount: 2, message: null });
    expect(store.get(all)).toMatchObject({ filter: null, messageCount: 5 });
    expect(store.get(discarded)).toMatchObject({ filter: null, messageCount: null });
    expect(store.list({ action: 'export' }).map((e) => e.id)).toEqual([all, filtered]);
  });
});
