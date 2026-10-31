// What only SQLite has: its migrations. The audit store contract covers the rest.
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { NewAuditEntry } from '../../src/server/audit/audit-store.js';
import { AUDIT_DB_FILE, SqliteAuditStore } from '../../src/server/audit/sqlite-audit-store.js';

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

describe('SqliteAuditStore migrations', () => {
  let store: SqliteAuditStore | undefined;
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'audit-store-'));
    await new SqliteAuditStore(dir).close();
  });
  afterEach(async () => {
    await store?.close();
    store = undefined;
    await rm(dir, { recursive: true, force: true });
  });

  it('reads entries written before roles existed back with none', async () => {
    // Turn it back into a version 3 store holding one entry.
    const db = new DatabaseSync(path.join(dir, AUDIT_DB_FILE));
    // Newest first: v14 (#79 Alerts), v13 (#73 depth history), v12 (#78 notifications), v11 (#65 automatic stop), v10 (#64 rule state), v9 (#58 canary), v8 (#63 rule), v7 (#56 rate), v6 (#44 export), v5 (#45 approver), v4 (#38 role).
    db.exec(`DROP TABLE alert_queue_arrivals; DROP TABLE alerts; DROP INDEX audit_entries_profile_queue_time; DROP TABLE sampling_runs; DROP TABLE history_samples;
             DROP TABLE notifications; DROP TABLE replay_rule_died_again; DROP TABLE replay_rule_state; DROP TABLE replay_rule_passes; DROP TABLE replay_rule_first_seen;
             ALTER TABLE audit_entries DROP COLUMN canary_outcome; ALTER TABLE audit_entries DROP COLUMN canary;
             DROP INDEX audit_entries_rule; ALTER TABLE audit_entries DROP COLUMN rule; ALTER TABLE audit_entries DROP COLUMN rule_pass_id;
             ALTER TABLE audit_entries DROP COLUMN rate;
             ALTER TABLE audit_entries DROP COLUMN filter; ALTER TABLE audit_entries DROP COLUMN message_count;
             ALTER TABLE audit_entries DROP COLUMN approver_id; ALTER TABLE audit_entries DROP COLUMN approver_name;
             ALTER TABLE audit_entries DROP COLUMN operator_role; PRAGMA user_version = 3;`);
    db.exec(`INSERT INTO audit_entries (created_at, operator_id, operator_name, broker_user, profile, vhost, queue, action, outcome)
             VALUES (0, 'sub-1', 'ana', 'volveran-admin', 'local', '/', 'orders.dlq', 'replay', 'done')`);
    db.close();

    store = new SqliteAuditStore(dir);

    const id = await store.record(entry({ role: 'operator' }));
    expect((await store.get(id))?.role).toBe('operator');
    expect((await store.list())[1]).toMatchObject({
      queue: 'orders.dlq',
      role: null,
      approverId: null,
      approverName: null,
      filter: null,
      messageCount: null,
      rate: null,
      rule: null,
      rulePassId: null,
      canary: false,
      canaryOutcome: null,
    });
  });

  it('upgrades a v15 store: its sampling runs and notifications keep no interval or Replay Rule', async () => {
    const db = new DatabaseSync(path.join(dir, AUDIT_DB_FILE));
    db.exec(`ALTER TABLE sampling_runs DROP COLUMN interval_ms; ALTER TABLE notifications DROP COLUMN replay_rule; PRAGMA user_version = 15;
             INSERT INTO sampling_runs (profile, at, ok, error_code) VALUES ('local', 5, 1, NULL);
             INSERT INTO notifications (at, alert_id, destination, destination_type, status, test, rule, profile, outcome, attempts)
             VALUES (5, 'a', 'pager', 'webhook', 'firing', 0, 'stopped', 'local', 'delivered', 1);`);
    db.close();
    store = new SqliteAuditStore(dir);
    expect((await store.history.lastRuns('local')).last).toMatchObject({ at: 5, intervalMs: null });
    expect((await store.notifications.recent())[0]).toMatchObject({ alertId: 'a', replayRule: null });
  });

  it('upgrades a store written before replay ids existed, keeping its entries', async () => {
    // Turn it back into a version 1 store holding one entry.
    const db = new DatabaseSync(path.join(dir, AUDIT_DB_FILE));
    // Newest first: v10 (#64), v9 (#58), v8 (#63), v7 (#56), v6 (#44), v5 (#45), then v3 (#10), v2 (#8) and v4 (#38) as before.
    db.exec(`DROP TABLE alert_queue_arrivals; DROP TABLE alerts; DROP INDEX audit_entries_profile_queue_time; DROP TABLE sampling_runs; DROP TABLE history_samples;
             DROP TABLE notifications; DROP TABLE replay_rule_died_again; DROP TABLE replay_rule_state; DROP TABLE replay_rule_passes; DROP TABLE replay_rule_first_seen;
             ALTER TABLE audit_entries DROP COLUMN canary_outcome; ALTER TABLE audit_entries DROP COLUMN canary;
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

    store = new SqliteAuditStore(dir);

    expect(await store.list()).toEqual([expect.objectContaining({ queue: 'orders.dlq', action: 'replay', replayId: null })]);
    const id = await store.record(entry({ action: 'move', reason: null, replayId: 'r-9' }));
    expect((await store.list({ replayId: 'r-9' })).map((e) => e.id)).toEqual([id]);
    // Versions 3 (#10), 4 (#38), 5 (#45) and 6 (#44) came along too.
    expect((await store.list())[1]).toMatchObject({
      restoreOf: null,
      bodyExpiredAt: null,
      role: null,
      approverId: null,
      approverName: null,
      filter: null,
      messageCount: null,
    });
  });
});
