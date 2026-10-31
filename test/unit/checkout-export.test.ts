// An export with a store that answers late (ADR 0013): what it holds is settled
// when it starts, and its Audit Entry's outcome is stored before the download ends.
// test/integration/export.test.ts covers the rest against a real broker.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AuditStore } from '../../src/server/audit/audit-store.js';
import { SqliteAuditStore } from '../../src/server/audit/sqlite-audit-store.js';
import { startExport } from '../../src/server/checkout/export.js';
import type { Checkout } from '../../src/server/checkout/state.js';
import { delayedAuditStore } from '../support/delayed-audit-store.js';

const delivery = (messageId: string) => ({
  fields: { exchange: '', routingKey: 'orders', redelivered: false },
  properties: { messageId, headers: {} },
  content: Buffer.from(messageId),
});

const checkoutOf = (ids: string[]) =>
  ({
    id: 'c-1',
    status: 'active',
    applying: null,
    operator: { id: 'ana', displayName: 'Ana' },
    brokerUser: 'svc',
    profile: { name: 'local' },
    vhost: '/',
    queue: 'orders.dlq',
    queueType: 'classic',
    deliveryLimit: null,
    deadLetterExchange: false,
    held: new Map(ids.map((id, i) => [i + 1, delivery(id)])),
    decisions: new Map(),
  }) as unknown as Checkout;

describe('an export on a store that answers late', () => {
  let sqlite: SqliteAuditStore;
  let slow: AuditStore;
  const entry = async () => (await sqlite.list({ action: 'export' }))[0];

  beforeEach(() => {
    sqlite = new SqliteAuditStore();
    slow = delayedAuditStore(sqlite);
  });
  afterEach(() => sqlite.close());

  it('has its pending Audit Entry stored once it has started', async () => {
    const started = await startExport(checkoutOf(['a']), null, { audit: slow, role: 'operator' });
    expect(started.count).toBe(1);
    expect(await entry()).toMatchObject({ outcome: 'pending', messageCount: 1 });
  });

  it('keeps the Messages and Decisions as they were when it started', async () => {
    const checkout = checkoutOf(['a', 'b']);
    const starting = startExport(checkout, null, { audit: slow, role: 'operator' });
    checkout.held.clear();
    checkout.decisions.set(1, { kind: 'discard', reason: 'too late' } as never);
    const lines: string[] = [];
    for await (const line of (await starting).lines) lines.push(line);
    expect(lines.map((l) => JSON.parse(l))).toMatchObject([
      { messageId: 'a', decision: { kind: 'keep' } },
      { messageId: 'b', decision: { kind: 'keep' } },
    ]);
  });

  it('has stored the outcome by the time the last line has been read', async () => {
    const { lines } = await startExport(checkoutOf(['a', 'b']), null, { audit: slow, role: 'operator' });
    for await (const _ of lines);
    expect(await entry()).toMatchObject({ outcome: 'done' });
  });

  it('has stored the failure by the time a stopped download has closed', async () => {
    const { lines } = await startExport(checkoutOf(['a', 'b']), null, { audit: slow, role: 'operator' });
    const reading = lines[Symbol.asyncIterator]();
    await reading.next();
    await reading.return!(undefined);
    expect(await entry()).toMatchObject({ outcome: 'failed', outcomeReason: 'The download stopped after 1 of 2 Messages.' });
  });

  it('refuses a Checkout that is over, recording nothing', async () => {
    const checkout = checkoutOf(['a']);
    checkout.status = 'ended' as Checkout['status'];
    await expect(startExport(checkout, null, { audit: slow, role: 'operator' })).rejects.toMatchObject({ code: 'checkout_not_active' });
    expect(await sqlite.list({ action: 'export' })).toEqual([]);
  });
});
