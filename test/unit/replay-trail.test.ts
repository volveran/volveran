// The Died Again chain through the audit store: a Replay's entry names the replay
// id it carried, a Restore's comes from the Discard it republished.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { replayTrail } from '../../src/server/audit/replay-trail.js';
import { AuditStore as SyncAuditStore, type NewAuditEntry } from '../../src/server/audit/store.js';
import { diedAgain } from '../../src/server/triage/died-again.js';
import { delayedAuditStore } from '../support/delayed-audit-store.js';

const headers = (replayId?: string) => (replayId ? { 'x-volveran-replay-id': replayId } : {});

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

describe('replayTrail', () => {
  let sync: SyncAuditStore;
  beforeEach(() => {
    sync = new SyncAuditStore();
  });
  afterEach(() => sync.close());

  const copy = (replayId?: string) => ({ body: null, properties: {}, headers: headers(replayId) });

  it('follows a Replay, and a Restore through the Discard it republished', async () => {
    sync.record(entry({ replayId: 'r1', message: copy() }));
    const discard = sync.record(entry({ action: 'discard', message: { ...copy('r1'), body: Buffer.from('x') } }));
    const restore = sync.record(entry({ action: 'restore', restoreOf: discard, replayId: 'r2' }));
    const trail = replayTrail(delayedAuditStore(sync.async));

    expect(await diedAgain(headers('r2'), trail)).toMatchObject({ replayId: 'r2', count: 2, last: { auditEntryId: restore, action: 'restore' } });
  });

  it('shows nothing of a Broker Profile outside the scope', async () => {
    sync.record(entry({ replayId: 'r1', message: copy() }));
    const trail = replayTrail(sync.async, { only: ['other'] });
    expect(await diedAgain(headers('r1'), trail)).toEqual({ replayId: 'r1', count: 1, last: null });
  });
});
