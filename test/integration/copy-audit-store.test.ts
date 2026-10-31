// `copy-audit-store` as an operator runs it: the command, on a SQLite store, into a real
// PostgreSQL. The upgrade suite (upgrade.test.ts) proves on every release's store, on
// PostgreSQL, that the copy works in the app. This holds what the command itself promises.
import { spawn } from 'node:child_process';
import { readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { repoRoot } from '../../scripts/test-broker-env.mjs';
import type { NewAuditEntry, NewNotificationDelivery } from '../../src/server/audit/audit-store.js';
import { PostgresAuditStore } from '../../src/server/audit/postgres-audit-store.js';
import { AUDIT_DB_FILE, SqliteAuditStore } from '../../src/server/audit/sqlite-audit-store.js';
import { createTestDatabase, type TestDatabase } from '../support/test-postgres.js';
import { copyFixtureStore, RELEASED_VERSIONS } from '../support/upgrade-fixtures.js';
import { closedPort, makeTempDir } from './harness.js';

const NUL_ID = 'msg\0with\u0001both';
const AT = new Date('2026-01-02T03:04:05.000Z');
const BODY = Buffer.from([0x00, 0xff, 0x01, 0xfe, 0x00]);

const entry = (overrides: Partial<NewAuditEntry> = {}): NewAuditEntry => ({
    at: AT,
    operator: { id: 'ada', displayName: 'Ada' },
    brokerUser: 'broker',
    profile: 'prod',
    vhost: '/',
    queue: 'orders.dlq',
    messageId: 'm-1',
    action: 'discard',
    reason: 'bad',
    destination: null,
    checkoutId: 'c-1',
    message: null,
    ...overrides,
  });

const TABLES = [
  'alert_queue_arrivals',
  'alerts',
  'audit_entries',
  'audit_message_bodies',
  'history_samples',
  'notifications',
  'replay_rule_died_again',
  'replay_rule_first_seen',
  'replay_rule_passes',
  'replay_rule_state',
  'sampling_runs',
];

const delivery = (alertId: string): NewNotificationDelivery => ({
  at: AT,
  alertId,
  destination: 'hook',
  destinationType: 'webhook',
  status: 'firing',
  test: false,
  rule: 'r',
  profile: 'prod',
  vhost: '/',
  queue: 'orders.dlq',
  outcome: 'delivered',
  httpStatus: 200,
  error: null,
  attempts: 1,
  replayRule: null,
});

/** A row in every table, through the store's own calls. Returns the ids to look for later. */
async function seed(dataDir: string): Promise<{ discard: number; restore: number; expired: number; highest: number }> {
  const store = new SqliteAuditStore(dataDir);
  const expired = await store.record(entry({ messageId: 'expired', message: { body: Buffer.from('gone'), properties: {}, headers: {} } }));
  const discard = await store.record(entry({ messageId: NUL_ID, message: { body: BODY, properties: { contentType: 'x/y' }, headers: { h: 'v' } } }));
  await store.setOutcome(discard, 'done');
  const restore = await store.record(entry({ action: 'restore', restoreOf: discard, replayId: 'replay-1' }));
  const highest = await store.record(entry({ action: 'replay', rule: 'rule', rulePassId: 'pass-1', replayId: 'replay-2' }));
  await store.evictBodies({ now: new Date(), maxAgeMs: Number.MAX_SAFE_INTEGER, maxBodyBytes: BODY.length });
  const key = 'prod/rule';
  await store.ruleState.ensure(key, false);
  await store.ruleState.setPaused(key, { reason: 'why', by: 'Ada', at: AT });
  await store.ruleState.recordPass(key, { id: 'pass-1', at: AT.toISOString(), status: 'ran', reason: null, summary: { held: 1, replayed: 1, moved: 0, usedUp: 0, notDue: 0, noMatch: 0, cannotReplay: 0, failed: 0 } });
  await store.ruleState.firstSeen(key, [NUL_ID], AT);
  await store.ruleState.countDiedAgain(key, { profile: 'prod', name: 'rule' }, [highest], AT, new Date(0));
  await store.notifications.record(delivery('alert-1'));
  await store.history.recordRun('prod', { at: 1000, ok: true, errorCode: null, intervalMs: 60_000 }, [{ vhost: '/', queue: 'orders.dlq', at: 1000, depth: 7, estimatedArrivals: 2 }]);
  await store.alerts.save('prod', {
    alerts: [{ alertId: 'a', rule: 'r', vhost: '/', queue: 'orders.dlq', status: 'firing', condition: 'depthAbove', value: 2.5, threshold: 1, since: 1000, lastNotifiedAt: null, falseSince: null, replayRule: null, reason: null }],
    arrivals: [{ vhost: '/', queue: 'orders.dlq', unsettled: 1, recent: [{ at: 1000, count: 2 }] }],
  });
  await store.close();
  return { discard, restore, expired, highest };
}

function run(env: Record<string, string>, args: string[] = []): Promise<{ code: number | null; out: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', 'tsx', 'src/server/main.ts', 'copy-audit-store', ...args], { cwd: repoRoot, env: { PATH: process.env.PATH, ...env } });
    let out = '';
    child.stdout.on('data', (chunk: Buffer) => (out += chunk.toString()));
    child.stderr.on('data', (chunk: Buffer) => (out += chunk.toString()));
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, out }));
  });
}

describe('copy-audit-store', () => {
  let dataDir: string;
  let target: TestDatabase;
  const copy = () => run({ VOLVERAN_DATA_DIR: dataDir, VOLVERAN_POSTGRES_URL: target.url });
  const countIn = async (table: string) => Number((await target.query(`SELECT count(*) AS n FROM ${table}`)).rows[0].n);

  beforeEach(async () => {
    dataDir = await makeTempDir('copy-store');
    target = await createTestDatabase();
  });
  afterEach(async () => {
    await rm(dataDir, { recursive: true, force: true });
    await target.drop();
  });

  it('copies every table, says how many rows of each, and they read back the same', async () => {
    const { discard, restore, expired } = await seed(dataDir);
    const { code, out } = await copy();
    expect(out).toMatch(/OK/);
    expect(code).toBe(0);
    for (const table of TABLES) {
      const rows = table === 'audit_entries' ? 4 : 1;
      expect(await countIn(table)).toBe(rows);
      expect(out).toMatch(new RegExp(`^${table}: ${rows} rows`, 'm'));
    }

    const source = new SqliteAuditStore(dataDir);
    const copied = await PostgresAuditStore.open(target.url);
    try {
      expect(await copied.list()).toEqual(await source.list());
      expect((await copied.get(discard))!.messageId).toBe(NUL_ID);
      expect((await copied.get(restore))!.restoreOf).toBe(discard);
      expect(await copied.body(discard)).toEqual(BODY);
      expect(await copied.body(expired)).toBeNull();
      const key = 'prod/rule';
      expect(await copied.ruleState.state(key)).toEqual(await source.ruleState.state(key));
      expect(await copied.ruleState.passes(key)).toEqual(await source.ruleState.passes(key));
      expect(await copied.ruleState.firstSeenAt(key, [NUL_ID])).toEqual(new Map([[NUL_ID, AT]]));
      expect(await copied.notifications.recent()).toEqual(await source.notifications.recent());
      expect(await copied.history.lastRuns('prod')).toEqual(await source.history.lastRuns('prod'));
      expect(await copied.history.samples({ profile: 'prod', vhost: '/', queue: 'orders.dlq' }, 0, 2000)).toEqual([{ at: 1000, depth: 7, estimatedArrivals: 2 }]);
      expect(await copied.alerts.load('prod')).toEqual(await source.alerts.load('prod'));
    } finally {
      await source.close();
      await copied.close();
    }
  });

  it('continues every id after the highest ever used, even one whose row is gone', async () => {
    const { highest } = await seed(dataDir);
    const store = new SqliteAuditStore(dataDir);
    const keep = (await store.notifications.record(delivery('alert-2'))).id;
    await store.notifications.record(delivery('alert-3'));
    await store.ruleState.recordPass('prod/rule', { id: 'pass-2', at: AT.toISOString(), status: 'ran', reason: null, summary: null });
    await store.close();
    const db = new DatabaseSync(path.join(dataDir, AUDIT_DB_FILE));
    db.exec(`DELETE FROM notifications WHERE id > ${keep}; DELETE FROM replay_rule_passes WHERE id = 'pass-2';`);
    db.close();

    expect((await copy()).code).toBe(0);

    const copied = await PostgresAuditStore.open(target.url);
    try {
      expect(await copied.record(entry())).toBe(highest + 1);
      expect((await copied.notifications.record(delivery('alert-4'))).id).toBe(keep + 2);
      await copied.ruleState.recordPass('prod/rule', { id: 'pass-3', at: AT.toISOString(), status: 'ran', reason: null, summary: null });
      expect((await target.query(`SELECT seq FROM replay_rule_passes WHERE id = 'pass-3'`)).rows[0].seq).toBe('3');
    } finally {
      await copied.close();
    }
  });

  it('starts ids at 1 for a table the source never used', async () => {
    new SqliteAuditStore(dataDir).close();
    expect((await copy()).code).toBe(0);
    const copied = await PostgresAuditStore.open(target.url);
    try {
      expect(await copied.record(entry())).toBe(1);
    } finally {
      await copied.close();
    }
  });

  it.each(RELEASED_VERSIONS)('brings a store of %s up to date first, and copies it', async (version) => {
    await copyFixtureStore(version, dataDir);
    const { code, out } = await copy();
    expect(out).toMatch(/OK/);
    expect(code).toBe(0);
    expect(await countIn('audit_entries')).toBeGreaterThan(0);
    expect(await countIn('audit_message_bodies')).toBeGreaterThan(0);
  });

  it('refuses a target that already holds rows, and leaves it as it was', async () => {
    await seed(dataDir);
    const existing = await PostgresAuditStore.open(target.url);
    await existing.notifications.record(delivery('already-here'));
    await existing.close();

    const { code, out } = await copy();
    expect(code).toBe(1);
    expect(out).toMatch(/not empty/);
    expect(out).toContain('notifications');
    expect(await countIn('audit_entries')).toBe(0);
    expect(await countIn('notifications')).toBe(1);
  });

  it('refuses a second copy into the same target', async () => {
    await seed(dataDir);
    expect((await copy()).code).toBe(0);
    const { code, out } = await copy();
    expect(code).toBe(1);
    expect(out).toMatch(/not empty/);
    expect(await countIn('audit_entries')).toBe(4);
  });

  it('accepts a target Volverán has only set up, with its tables but no rows', async () => {
    await seed(dataDir);
    await (await PostgresAuditStore.open(target.url)).close();
    expect((await copy()).code).toBe(0);
  });

  it('commits nothing when a row count does not match, so it can be run again', async () => {
    await seed(dataDir);
    await (await PostgresAuditStore.open(target.url)).close();
    await target.query(`CREATE FUNCTION drop_row() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NULL; END $$`);
    await target.query(`CREATE TRIGGER lose_samples BEFORE INSERT ON history_samples FOR EACH ROW EXECUTE FUNCTION drop_row()`);

    const { code, out } = await copy();
    expect(code).toBe(1);
    expect(out).toMatch(/history_samples.*1.*0/);
    expect(await countIn('audit_entries')).toBe(0);

    await target.query('DROP TRIGGER lose_samples ON history_samples');
    expect((await copy()).code).toBe(0);
    expect(await countIn('history_samples')).toBe(1);
  });

  it('refuses a source table the target has no place for, rather than leaving it behind', async () => {
    await seed(dataDir);
    const db = new DatabaseSync(path.join(dataDir, AUDIT_DB_FILE));
    db.exec('CREATE TABLE from_the_future (id INTEGER PRIMARY KEY)');
    db.close();
    const { code, out } = await copy();
    expect(code).toBe(1);
    expect(out).toContain('from_the_future');
    expect(await countIn('audit_entries')).toBe(0);
  });

  it('refuses when there is no store to copy, and creates none', async () => {
    const { code, out } = await copy();
    expect(code).toBe(1);
    expect(out).toContain(path.join(dataDir, AUDIT_DB_FILE));
    expect(out).toMatch(/No SQLite audit store/);
    expect(await readdir(dataDir)).toEqual([]);
  });

  it('refuses a store newer than this version', async () => {
    await seed(dataDir);
    const db = new DatabaseSync(path.join(dataDir, AUDIT_DB_FILE));
    db.exec('PRAGMA user_version = 9999');
    db.close();
    const { code, out } = await copy();
    expect(code).toBe(1);
    expect(out).toMatch(/schema version 9999/);
  });

  it('refuses a file that is not a SQLite database, in one line', async () => {
    await writeFile(path.join(dataDir, AUDIT_DB_FILE), 'not a database, not at all, '.repeat(100));
    const { code, out } = await copy();
    expect(code).toBe(1);
    expect(out.trim().split('\n')).toHaveLength(1);
    expect(out).toContain(AUDIT_DB_FILE);
  });

  it('needs VOLVERAN_POSTGRES_URL, and takes no arguments', async () => {
    const without = await run({ VOLVERAN_DATA_DIR: dataDir });
    expect(without.code).toBe(1);
    expect(without.out).toContain('VOLVERAN_POSTGRES_URL');
    const extra = await run({ VOLVERAN_DATA_DIR: dataDir, VOLVERAN_POSTGRES_URL: target.url }, ['somewhere']);
    expect(extra.code).toBe(1);
    expect(extra.out).toMatch(/takes no arguments/);
  });

  it('never prints the password in the URL', async () => {
    await seed(dataDir);
    const password = new URL(target.url).password;
    const results = [await copy(), await copy()];
    const wrongPassword = new URL(target.url);
    wrongPassword.password = 'another-secret-pass';
    results.push(await run({ VOLVERAN_DATA_DIR: dataDir, VOLVERAN_POSTGRES_URL: wrongPassword.href }));
    const unreachable = new URL(target.url);
    unreachable.port = String(await closedPort());
    results.push(await run({ VOLVERAN_DATA_DIR: dataDir, VOLVERAN_POSTGRES_URL: unreachable.href }));
    expect(results.map((r) => r.code)).toEqual([0, 1, 1, 1]);
    for (const { out } of results) {
      expect(out).not.toContain(password);
      expect(out).not.toContain('another-secret-pass');
    }
    expect(results[2]!.out).toMatch(/refused the user/);
    expect(results[3]!.out).toMatch(/Could not reach PostgreSQL/);
  });
});
