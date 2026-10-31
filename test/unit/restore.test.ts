// Restore with a store that answers late (ADR 0013): the pending Audit Entry is
// durable before the publish, and only one of two requests for an entry goes on.
// test/integration/audit.test.ts covers the rest against a real broker.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuditStore } from '../../src/server/audit/audit-store.js';
import { RestoreService } from '../../src/server/audit/restore.js';
import { AuditStore as SyncAuditStore } from '../../src/server/audit/store.js';
import type { ProfileAccess } from '../../src/server/profile-access.js';
import { delayedAuditStore } from '../support/delayed-audit-store.js';

const opened = vi.hoisted(() => ({ run: async () => {} }));
vi.mock('../../src/server/amqp-connection.js', () => ({
  openAmqpConnection: async () => {
    await opened.run();
    throw new Error('no broker here');
  },
}));

const OPERATOR = { id: 'ana', displayName: 'Ana' };
const target = {
  profile: { name: 'local', protected: false, vhosts: 'all', credentials: { kind: 'shared' } },
  role: 'admin',
  management: { getQueue: async () => ({ name: 'orders.dlq' }) },
  credentials: () => ({ brokerUser: 'svc' }),
} as unknown as ProfileAccess;

describe('Restore on a store that answers late', () => {
  let sync: SyncAuditStore;
  let slow: AuditStore;
  let discardId: number;

  beforeEach(() => {
    sync = new SyncAuditStore();
    slow = delayedAuditStore(sync.async);
    discardId = sync.record({
      at: new Date('2026-10-01T12:00:00.000Z'),
      operator: OPERATOR,
      brokerUser: 'svc',
      profile: 'local',
      vhost: '/',
      queue: 'orders.dlq',
      messageId: 'm-1',
      action: 'discard',
      reason: 'bad payload',
      destination: null,
      checkoutId: 'c-1',
      message: { body: Buffer.from('hello'), properties: {}, headers: {} },
    });
    sync.setOutcome(discardId, 'done');
    opened.run = async () => {};
  });
  afterEach(() => sync.close());

  const restore = (service: RestoreService) => service.restore(discardId, { confirm: true }, OPERATOR, target);
  const service = (audit: AuditStore = slow) => new RestoreService(audit, () => false);

  it('has its pending Audit Entry stored before it publishes', async () => {
    const atPublish: string[] = [];
    opened.run = async () => {
      atPublish.push(...sync.list({ restoreOf: discardId }).map((e) => e.outcome));
    };
    await restore(service());
    expect(atPublish).toEqual(['pending']);
  });

  it('answers the Restore with its outcome stored', async () => {
    const entry = await restore(service());
    expect(entry).toMatchObject({ action: 'restore', restoreOf: discardId, outcome: 'failed', outcomeReason: 'no broker here' });
  });

  it('lets only one of two requests for the same entry go on', async () => {
    const s = service();
    const results = await Promise.allSettled([restore(s), restore(s)]);
    expect(results.map((r) => r.status).sort()).toEqual(['fulfilled', 'rejected']);
    expect(results.find((r) => r.status === 'rejected')).toMatchObject({ reason: { code: 'restore_in_progress' } });
    expect(sync.list({ restoreOf: discardId })).toHaveLength(1);
  });

  it('refuses a second Restore once the first has done its work', async () => {
    const { id: _id, ...discard } = sync.get(discardId)!;
    sync.record({ ...discard, operator: OPERATOR, action: 'restore', restoreOf: discardId, message: null });
    await expect(restore(service())).rejects.toMatchObject({ code: 'already_restored' });
  });

  it('frees the entry when a store call fails', async () => {
    const failing: AuditStore = new Proxy(slow, {
      get: (t, key) => (key === 'list' ? () => Promise.reject(new Error('store down')) : Reflect.get(t, key)),
    });
    let listFails = true;
    const once: AuditStore = new Proxy(slow, {
      get: (t, key) => (key === 'list' && listFails ? failing.list : Reflect.get(t, key)),
    });
    const s = service(once);
    await expect(restore(s)).rejects.toThrow('store down');
    listFails = false;
    await expect(restore(s)).resolves.toMatchObject({ action: 'restore' });
  });
});
