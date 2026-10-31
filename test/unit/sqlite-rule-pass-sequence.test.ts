// The migration that gave Rule Passes an explicit sequence, in place of SQLite's rowid.
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { AUDIT_DB_FILE, SqliteAuditStore } from '../../src/server/audit/sqlite-audit-store.js';

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'audit-store-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

it('keeps the order of the passes of a v16 store, and adds to it', async () => {
  await new SqliteAuditStore(dir).close();
  const db = new DatabaseSync(path.join(dir, AUDIT_DB_FILE));
  db.exec(`DROP TABLE replay_rule_passes;
           CREATE TABLE replay_rule_passes (
             id TEXT PRIMARY KEY, rule_key TEXT NOT NULL, at INTEGER NOT NULL, status TEXT NOT NULL, reason TEXT,
             held INTEGER, replayed INTEGER, moved INTEGER, used_up INTEGER, not_due INTEGER, no_match INTEGER, failed INTEGER,
             cannot_replay INTEGER);
           INSERT INTO replay_rule_passes (id, rule_key, at, status) VALUES ('z-first', 'local/r', 5, 'skipped'), ('a-second', 'local/r', 5, 'skipped');
           PRAGMA user_version = 16;`);
  db.close();

  const store = new SqliteAuditStore(dir);
  const at = new Date(5).toISOString();
  await store.ruleState.recordPass('local/r', { id: 'm-third', at, status: 'skipped', summary: null, reason: null });

  expect((await store.ruleState.passes('local/r')).map((p) => p.id)).toEqual(['m-third', 'a-second', 'z-first']);
  await store.close();
});
