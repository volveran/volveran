// The Died Again chain when the store takes its time; the audit store contract
// covers what the chain reads.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { NewAuditEntry } from '../../src/server/audit/audit-store.js';
import { replayTrail } from '../../src/server/audit/replay-trail.js';
import { SqliteAuditStore } from '../../src/server/audit/sqlite-audit-store.js';
import { diedAgain } from '../../src/server/triage/died-again.js';
import { delayedAuditStore } from '../support/delayed-audit-store.js';

const headers = (replayId?: string) => (replayId ? { 'x-volveran-replay-id': replayId } : {});
const copy = (replayId?: string) => ({ body: null, properties: {}, headers: headers(replayId) });

function entry(overrides: Partial<NewAuditEntry>): NewAuditEntry {
  return {
    at: new Date('2026-10-01T12:00:00.000Z'),
    operator: { id: 'ana', displayName: 'Ana' },
    brokerUser: 'svc',
    profile: 'local',
    vhost: '/',
    queue: 'orders.dlq',
    messageId: 'm-1',
    action: 'replay',
    reason: null,
    destination: null,
    checkoutId: 'c-1',
    message: null,
    ...overrides,
  };
}

describe('replayTrail on a delayed store', () => {
  let store: SqliteAuditStore;
  beforeEach(() => {
    store = new SqliteAuditStore();
  });
  afterEach(() => store.close());

  it('follows a Restore through the Discard it republished', async () => {
    await store.record(entry({ replayId: 'r1', message: copy() }));
    const discard = await store.record(entry({ action: 'discard', message: { ...copy('r1'), body: Buffer.from('x') } }));
    const restore = await store.record(entry({ action: 'restore', restoreOf: discard, replayId: 'r2' }));

    expect(await diedAgain(headers('r2'), replayTrail(delayedAuditStore(store)))).toMatchObject({
      replayId: 'r2',
      count: 2,
      last: { auditEntryId: restore, action: 'restore' },
    });
  });
});
