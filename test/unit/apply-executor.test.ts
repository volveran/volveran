// The Apply executor with an in-memory audit store and a fake broker (the ack).
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type * as amqp from 'amqplib';
import { AuditStore } from '../../src/server/audit/store.js';
import { executeApply, type ApplyRun } from '../../src/server/apply/executor.js';
import { AckUncertainError, type ApplyContext } from '../../src/server/apply/types.js';
import type { BrokerProfile } from '../../src/server/profiles.js';
import type { ApplyPlan } from '../../src/server/triage/decisions.js';

const profile = { name: 'local', username: 'volveran-admin', protected: false } as BrokerProfile;
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
        target: { checkoutId: 'c-1', profile, vhost: '/', queue: 'orders.dlq', operator },
        startedAt: new Date(),
        ack,
        publish: async () => ({ ok: false, reason: 'no broker in unit tests' }),
      },
      audit,
      usable: () => true,
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

  it('checks the Checkout before every step and does not attempt the rest once it is no longer active', async () => {
    let active = true;
    const acked: number[] = [];
    const { outcomes } = run(
      { kept: [], steps: [1, 2, 3].map((handle) => ({ handle, decision: DISCARD })) },
      async (m) => {
        acked.push(m.fields.deliveryTag);
        active = false; // e.g. the connection dropped right after this ack
      },
      { usable: () => active },
    );

    expect((await outcomes).map((o) => [o.handle, o.status])).toEqual([
      [1, 'done'],
      [2, 'not-attempted'],
      [3, 'not-attempted'],
    ]);
    expect(acked).toEqual([1]);
    expect(audit.list().map((e) => e.messageId)).toEqual(['m-1']);
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

  it.each([['Move', { kind: 'move', destination: { queue: 'triage.manual' } }]] as const)('does not attempt a %s, which this version cannot carry out yet, and still applies the rest', async (name, decision) => {
    const acked: number[] = [];
    const { outcomes } = run(
      { kept: [], steps: [{ handle: 1, decision }, { handle: 2, decision: DISCARD }] },
      async (m) => {
        acked.push(m.fields.deliveryTag);
      },
    );

    expect(await outcomes).toEqual([
      {
        handle: 1,
        messageId: 'm-1',
        decision,
        status: 'not-attempted',
        reason: `${name} is not available yet in this version of Volverán. The Message goes back to the queue.`,
      },
      expect.objectContaining({ handle: 2, status: 'done' }),
    ]);
    expect(acked).toEqual([2]);
    expect(audit.list().map((e) => e.messageId)).toEqual(['m-2']);
  });
});
