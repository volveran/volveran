// Where a Replay sends a Message: the queue of its most recent x-death
// entry, or why it cannot be Replayed.
import { describe, expect, it } from 'vitest';
import { replayOrigin } from '../../src/server/triage/replay-origin.js';

describe('replayOrigin', () => {
  it('is the queue of the most recent x-death entry', () => {
    const headers = {
      'x-death': [
        { reason: 'expired', queue: 'orders.retry' },
        { reason: 'rejected', queue: 'orders.work' },
      ],
    };
    expect(replayOrigin(headers)).toEqual({ ok: true, queue: 'orders.retry' });
  });

  it('reads a queue name decoded as bytes', () => {
    expect(replayOrigin({ 'x-death': [{ queue: Buffer.from('payments.work') }] })).toEqual({
      ok: true,
      queue: 'payments.work',
    });
  });

  it('is unavailable, with the reason, without x-death history', () => {
    for (const headers of [undefined, {}, { 'x-death': [] }, { 'x-death': 'forged' }]) {
      expect(replayOrigin(headers)).toEqual({ ok: false, reason: expect.stringMatching(/no x-death history/) });
    }
  });

  it('is unavailable when the most recent entry names no queue', () => {
    expect(replayOrigin({ 'x-death': [{ reason: 'rejected' }, { queue: 'orders.work' }] })).toEqual({
      ok: false,
      reason: expect.stringMatching(/names no queue/),
    });
  });
});
