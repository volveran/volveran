// Whether a held Message is Died Again: its replay id, and the chain of
// earlier replay ids through the Audit Entries that gives the count.
import { describe, expect, it } from 'vitest';
import { diedAgain, type ReplayRecord, type ReplayTrail } from '../../src/server/triage/died-again.js';

const record = (auditEntryId: number, earlierReplayId: string | null): ReplayRecord => ({
  auditEntryId,
  action: 'replay',
  at: '2026-10-01T10:00:00.000Z',
  operatorName: 'Ana',
  fromQueue: 'orders.dlq',
  earlierReplayId,
});
const trailOf = (records: Record<string, ReplayRecord>): ReplayTrail => (id) => records[id] ?? null;

describe('diedAgain', () => {
  it('is null for a Message without a replay id', () => {
    for (const headers of [undefined, {}, { 'x-volveran-replay-id': '' }, { 'x-volveran-replay-id': 42 }]) {
      expect(diedAgain(headers, trailOf({}))).toBeNull();
    }
  });

  it('reads a replay id decoded as bytes', () => {
    expect(diedAgain({ 'x-volveran-replay-id': Buffer.from('r1') }, trailOf({ r1: record(7, null) }))).toEqual({
      replayId: 'r1',
      count: 1,
      last: { auditEntryId: 7, action: 'replay', at: '2026-10-01T10:00:00.000Z', operatorName: 'Ana', fromQueue: 'orders.dlq' },
    });
  });

  it('counts every replay id in the chain, also one with no Audit Entry here', () => {
    const trail = trailOf({ r3: record(9, 'r2'), r2: record(5, 'r1') });
    expect(diedAgain({ 'x-volveran-replay-id': 'r3' }, trail)).toMatchObject({ count: 3, last: { auditEntryId: 9 } });
  });

  it('stops at a chain that loops back on itself', () => {
    const trail = trailOf({ a: record(1, 'b'), b: record(2, 'a') });
    expect(diedAgain({ 'x-volveran-replay-id': 'a' }, trail)).toMatchObject({ count: 2 });
  });
});
