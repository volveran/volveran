// The Apply executor with an in-memory audit store and a fake broker (the ack).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as amqp from 'amqplib';
import { AuditStore } from '../../src/server/audit/store.js';
import { executeApply, type ApplyRun } from '../../src/server/apply/executor.js';
import { AckUncertainError, type ApplyContext } from '../../src/server/apply/types.js';
import type { BrokerProfile } from '../../src/server/profiles.js';
import type { ApplyPlan } from '../../src/server/triage/decisions.js';

const profile = { name: 'local', protected: false } as BrokerProfile;
const operator = { id: 'sub-1', displayName: 'ana@example.com' };
const DISCARD = { kind: 'discard', reason: 'duplicate' } as const;

function held(handle: number, headers: Record<string, unknown> = {}): amqp.ConsumeMessage {
  return {
    content: Buffer.from(`body-${handle}`),
    fields: { deliveryTag: handle, redelivered: false, exchange: '', routingKey: 'orders.dlq', consumerTag: 'c' },
    properties: { messageId: `m-${handle}`, contentType: 'text/plain', headers },
  } as unknown as amqp.ConsumeMessage;
}

describe('Apply executor', () => {
  let audit: AuditStore;
  beforeEach(() => {
    audit = new AuditStore();
  });
  afterEach(() => audit.close());

  /** Runs `plan` over Messages 1..n; `ack` stands in for the broker. */
  function run(plan: ApplyPlan, ack: ApplyContext['ack'], overrides: Partial<ApplyRun> = {}) {
    const handles = [...plan.kept, ...plan.steps.map((s) => s.handle)].sort((a, b) => a - b);
    const done: number[] = [];
    const outcomes = executeApply({
      plan,
      messages: new Map(handles.map((h) => [h, held(h)])),
      ctx: {
        target: {
          checkoutId: 'c-1',
          profile,
          vhost: '/',
          queue: 'orders.dlq',
          operator,
          role: 'operator',
          brokerUser: 'volveran-admin',
          approver: null,
          rule: null,
        },
        startedAt: new Date(),
        ack,
        publish: async () => ({ ok: false, reason: 'no broker in unit tests' }),
      },
      audit,
      stopReason: () => null,
      onDone: (handle) => done.push(handle),
      ...overrides,
    });
    return { outcomes, done };
  }

  it('stores a Discarded Message with its reason before acking it, and reports every Message in Checkout order', async () => {
    const storedBeforeAck: unknown[] = [];
    const { outcomes, done } = run(
      { kept: [1, 3], steps: [{ handle: 2, decision: DISCARD }] },
      async (m) => {
        const [entry] = audit.list();
        storedBeforeAck.push([entry?.outcome, audit.body(entry!.id)?.toString(), m.fields.deliveryTag]);
      },
    );

    expect(await outcomes).toEqual([
      { handle: 1, messageId: 'm-1', decision: { kind: 'keep' }, status: 'kept', reason: null },
      { handle: 2, messageId: 'm-2', decision: DISCARD, status: 'done', reason: null },
      { handle: 3, messageId: 'm-3', decision: { kind: 'keep' }, status: 'kept', reason: null },
    ]);
    expect(storedBeforeAck).toEqual([['pending', 'body-2', 2]]);
    expect(done).toEqual([2]);
    expect(audit.list()).toEqual([
      expect.objectContaining({
        action: 'discard',
        reason: 'duplicate',
        outcome: 'done',
        operatorId: 'sub-1',
        operatorName: 'ana@example.com',
        brokerUser: 'volveran-admin',
        messageId: 'm-2',
        checkoutId: 'c-1',
        message: { properties: { messageId: 'm-2', contentType: 'text/plain' }, headers: {}, bodyBytes: 6 },
      }),
    ]);
  });

  it('asks before every step whether to go on, and reports the rest not attempted with the reason once told to stop', async () => {
    let stop: string | null = null;
    const acked: number[] = [];
    const steps: unknown[] = [];
    const { outcomes } = run(
      { kept: [], steps: [1, 2, 3].map((handle) => ({ handle, decision: DISCARD })) },
      async (m) => {
        acked.push(m.fields.deliveryTag);
        stop = 'The Checkout reached its time limit.'; // e.g. the time limit, right after this ack
      },
      { stopReason: () => stop, onStep: (o) => steps.push([o.handle, o.status]) },
    );

    expect((await outcomes).map((o) => [o.handle, o.status, o.reason])).toEqual([
      [1, 'done', null],
      [2, 'not-attempted', 'The Checkout reached its time limit.'],
      [3, 'not-attempted', 'The Checkout reached its time limit.'],
    ]);
    expect(steps).toEqual([
      [1, 'done'],
      [2, 'not-attempted'],
      [3, 'not-attempted'],
    ]);
    expect(acked).toEqual([1]);
    expect(audit.list().map((e) => e.messageId)).toEqual(['m-1']);
  });

  it('starts Replay and Move steps at least 1/rate apart, without pacing Discards, and records the rate on every Audit Entry', async () => {
    vi.useFakeTimers();
    try {
      const REPLAY = { kind: 'replay' } as const;
      const MOVE = { kind: 'move', destination: { exchange: '', routingKey: 'orders.parked', queue: 'orders.parked' } } as const;
      const settledAt: Array<[number, number]> = [];
      const start = Date.now();
      const { outcomes } = run(
        {
          kept: [],
          steps: [
            { handle: 1, decision: REPLAY },
            { handle: 2, decision: DISCARD },
            { handle: 3, decision: MOVE },
            { handle: 4, decision: DISCARD },
            { handle: 5, decision: REPLAY },
          ],
        },
        async () => {},
        { rate: 10, onStep: (o) => settledAt.push([o.handle, Date.now() - start]) },
      );
      await vi.advanceTimersByTimeAsync(1_000);
      await outcomes;
      expect(settledAt).toEqual([
        [1, 0],
        [2, 0],
        [3, 100],
        [4, 100],
        [5, 200],
      ]);
      expect(audit.list().map((e) => e.rate)).toEqual([10, 10, 10, 10, 10]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('stops waiting for the next paced step as soon as it is told to stop', async () => {
    vi.useFakeTimers();
    try {
      const stop = new AbortController();
      let reason: string | null = null;
      const { outcomes } = run(
        { kept: [], steps: [1, 2].map((handle) => ({ handle, decision: { kind: 'replay' } as const })) },
        async () => {},
        { rate: 0.1, stopReason: () => reason, stopSignal: stop.signal },
      );
      await vi.advanceTimersByTimeAsync(1_000);
      reason = 'An Operator stopped the Apply.';
      stop.abort();
      await vi.advanceTimersByTimeAsync(0);
      expect((await outcomes).map((o) => [o.handle, o.status])).toEqual([
        [1, 'failed'],
        [2, 'not-attempted'],
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('records no rate on the Audit Entries of an Apply with no Replay Rate', async () => {
    const { outcomes } = run({ kept: [], steps: [{ handle: 1, decision: DISCARD }] }, async () => {});
    await outcomes;
    expect(audit.list().map((e) => e.rate)).toEqual([null]);
  });

  it('leaves the Message alone when its Audit Entry cannot be written', async () => {
    const acked: number[] = [];
    audit.close(); // every write now fails
    const { outcomes } = run({ kept: [], steps: [{ handle: 1, decision: DISCARD }] }, async (m) => {
      acked.push(m.fields.deliveryTag);
    });

    expect(await outcomes).toEqual([
      expect.objectContaining({ handle: 1, status: 'failed', reason: expect.stringMatching(/Audit Entry.*left in the queue/) }),
    ]);
    expect(acked).toEqual([]);
  });

  it('records a Discard whose ack never reached the broker as failed', async () => {
    const { outcomes, done } = run({ kept: [], steps: [{ handle: 1, decision: DISCARD }] }, async () => {
      throw new Error('Channel closed');
    });

    expect(await outcomes).toEqual([expect.objectContaining({ status: 'failed', reason: 'Channel closed' })]);
    expect(done).toEqual([]);
    expect(audit.list()[0]).toMatchObject({ outcome: 'failed', outcomeReason: 'Channel closed' });
  });

  it('records a Discard whose ack the broker may or may not have processed as uncertain, keeping the copy', async () => {
    const { outcomes } = run({ kept: [], steps: [{ handle: 1, decision: DISCARD }] }, async () => {
      throw new AckUncertainError('the connection dropped');
    });

    expect(await outcomes).toEqual([
      expect.objectContaining({ status: 'failed', reason: expect.stringContaining('may or may not') }),
    ]);
    const [entry] = audit.list();
    expect(entry).toMatchObject({ outcome: 'uncertain', messageId: 'm-1' });
    expect(audit.body(entry!.id)?.toString()).toBe('body-1');
  });
});
