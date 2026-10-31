// The migration that gave Rule Passes an explicit sequence, in place of SQLite's rowid, on a
// store 0.5.1 really wrote (schema version 16). The fixture holds one pass, so passes of the
// same moment are added to it, in an order their ids would not give.
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { AUDIT_DB_FILE, SqliteAuditStore } from '../../src/server/audit/sqlite-audit-store.js';
import { copyFixtureStore } from '../support/upgrade-fixtures.js';

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'audit-store-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

it('keeps the order of the passes of a 0.5.1 store, and adds to it', async () => {
  await copyFixtureStore('0.5.1', dir);
  const db = new DatabaseSync(path.join(dir, AUDIT_DB_FILE));
  expect(db.prepare('PRAGMA user_version').get()).toEqual({ user_version: 16 });
  const { id: written, rule_key: ruleKey, at: when } = db.prepare('SELECT id, rule_key, at FROM replay_rule_passes').get() as { id: string; rule_key: string; at: number };
  const add = db.prepare(`INSERT INTO replay_rule_passes (id, rule_key, at, status) VALUES (?, ?, ?, 'skipped')`);
  add.run('z-second', ruleKey, when);
  add.run('a-third', ruleKey, when);
  db.close();

  const store = new SqliteAuditStore(dir);
  await store.ruleState.recordPass(ruleKey, { id: 'm-fourth', at: new Date(when).toISOString(), status: 'skipped', summary: null, reason: null });

  expect((await store.ruleState.passes(ruleKey)).map((p) => p.id)).toEqual(['m-fourth', 'a-third', 'z-second', written]);
  await store.close();
});
