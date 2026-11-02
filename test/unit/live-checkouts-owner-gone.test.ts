// What another Replica answers of a record whose owner has gone, however it came to say so.
import { describe, expect, it } from 'vitest';
import type { NewLiveCheckout } from '../../src/server/audit/audit-store.js';
import { MemoryReplicaStore } from '../../src/server/audit/memory-replicas.js';
import { LiveCheckouts } from '../../src/server/replicas/live-checkouts.js';
import { ownerGoneReason } from '../../src/server/replicas/owner-gone.js';

const record = (overrides: Partial<NewLiveCheckout> = {}): NewLiveCheckout => ({
  id: 'c-1',
  ownerReplica: 'gone',
  operator: { id: 'sub-123', displayName: 'ana@example.com' },
  profile: 'local',
  vhost: '/',
  queue: 'orders.dlq',
  queueType: 'quorum',
  deliveryLimit: 20,
  readyAtStart: 3,
  startedAt: 1,
  endsAt: 2,
  status: 'active',
  approval: null,
  ...overrides,
});

describe('LiveCheckouts.ownerOf with the owner gone', () => {
  const setUp = async () => {
    const store = new MemoryReplicaStore();
    await store.renewLease({ replicaId: 'gone', forwardingAddress: 'gone:1', expiresAt: 1 });
    await store.renewLease({ replicaId: 'here', forwardingAddress: 'here:1', expiresAt: Date.now() + 60_000 });
    return { store, live: new LiveCheckouts(store, 'here', () => {}) };
  };

  it("gives the reason for a record that another start's claim made lost", async () => {
    const { store, live } = await setUp();
    await store.claimCheckout(record(), Date.now());
    await store.claimCheckout(record({ id: 'c-2', ownerReplica: 'here' }), Date.now());
    expect((await store.checkoutRecord('c-1'))?.lostReason).toBeNull();
    expect(await live.ownerOf('c-1')).toMatchObject({ gone: { status: 'lost', lostReason: ownerGoneReason('quorum') } });
  });

  it('gives the reason for a record still starting', async () => {
    const { store, live } = await setUp();
    await store.claimCheckout(record({ status: 'starting' }), Date.now());
    expect(await live.ownerOf('c-1')).toMatchObject({ gone: { status: 'lost', lostReason: ownerGoneReason('quorum') } });
  });

  it('keeps the reason a record has, and leaves one that ended as it is', async () => {
    const { store, live } = await setUp();
    await store.claimCheckout(record({ status: 'lost', lostReason: 'the broker closed it' }), Date.now());
    await store.claimCheckout(record({ id: 'c-2', status: 'ended', endReason: 'operator' }), Date.now());
    expect(await live.ownerOf('c-1')).toMatchObject({ gone: { status: 'lost', lostReason: 'the broker closed it' } });
    expect(await live.ownerOf('c-2')).toMatchObject({ gone: { status: 'ended', endReason: 'operator', lostReason: null } });
  });
});
