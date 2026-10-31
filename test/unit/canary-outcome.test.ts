// Writing a Canary's watch outcome, on a store that takes its time (ADR 0013).
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SqliteAuditStore } from '../../src/server/audit/sqlite-audit-store.js';
import { canaryHooks } from '../../src/server/checkout/canary.js';
import type { Checkout } from '../../src/server/checkout/state.js';
import { delayedAuditStore, type StoreDelay } from '../support/delayed-audit-store.js';

const FAILED = { handle: 1, messageId: 'm-1', decision: { kind: 'replay' }, status: 'failed', reason: 'no route' } as const;

describe('a Canary that failed', () => {
  let audit: SqliteAuditStore;
  let entryId: number;
  beforeEach(async () => {
    audit = new SqliteAuditStore();
    entryId = await audit.record({
      at: new Date(),
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
      canary: true,
    });
  });
  afterEach(() => audit.close());

  /** The Canary's hooks with the Apply already stopped, so nothing waits after it. */
  async function failedCanary(delay: StoreDelay) {
    const checkout = { held: new Map(), canaryWatch: new Map(), canary: null, applyProgress: null } as unknown as Checkout;
    const hooks = canaryHooks(checkout, {
      handle: 1,
      watchWindowMs: 1_000,
      audit: delayedAuditStore(audit, delay),
      stopSignal: AbortSignal.abort(),
      waitStarted: () => {},
      waitEnded: () => {},
    });
    await hooks.beforePublish(entryId, null);
    await hooks.afterStep(FAILED);
    return checkout;
  }

  it('has its outcome committed before the Apply goes on', async () => {
    const checkout = await failedCanary(20);

    expect(checkout.canary?.status).toBe('failed');
    expect((await audit.get(entryId))?.canaryOutcome).toBe('failed');
  });

  it('still shows on the Checkout when the outcome cannot be written', async () => {
    const checkout = await failedCanary(async () => {
      throw new Error('the database went away');
    });

    expect(checkout.canary?.status).toBe('failed');
    expect((await audit.get(entryId))?.canaryOutcome).toBeNull();
  });
});
