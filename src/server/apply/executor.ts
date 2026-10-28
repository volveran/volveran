// Apply executor (ADR 0001): carries out an Apply plan within a Checkout, one
// Message at a time. Each step is independent and there is no rollback: a
// failed step leaves its Message held, so it falls back to Keep.
//
// Before every step it asks whether the Checkout is still active: once it is
// not (a Lost Checkout: the connection or channel closed), the remaining
// steps are not attempted; the broker has already put their Messages back.
//
// For every attempted step an Audit Entry is written as `pending` (for a
// Discard, with the full Message, in a durable commit) before the broker is
// touched, then updated with the outcome. A crash in between leaves the
// Message in the queue *and* in the store: a duplicate, never a loss.
import type { AuditStore } from '../audit/store.js';
import type { ActionDecision, ApplyPlan, Decision } from '../triage/decisions.js';
import { handlerFor } from './handlers.js';
import { AckUncertainError, type ApplyContext, type AuditDetails, type HeldMessage, type MessageOutcome, type StepResult } from './types.js';

const KIND_LABEL: Record<ActionDecision['kind'], string> = { discard: 'Discard', replay: 'Replay', move: 'Move' };

export interface ApplyRun {
  plan: ApplyPlan;
  /** The Messages of the Checkout, by handle, in Checkout order. */
  messages: ReadonlyMap<number, HeldMessage>;
  ctx: ApplyContext;
  audit: AuditStore;
  /** False once the Checkout can no longer act on the broker; asked before every step. */
  usable(): boolean;
  /** Called as soon as a step is done, so its Message is no longer treated as held. */
  onDone(handle: number): void;
  /** Test seam: awaited after a step's `pending` Audit Entry is written, before the step touches the broker. */
  beforeStep?(entryId: number): Promise<void>;
}

/** Runs the plan; returns one outcome per Message of the plan, in Checkout order. */
export async function executeApply(run: ApplyRun): Promise<MessageOutcome[]> {
  const { plan, messages, ctx, audit } = run;
  const { target } = ctx;
  const outcomes = new Map<number, MessageOutcome>();
  const messageIdOf = (handle: number) => {
    const id = messages.get(handle)?.properties.messageId;
    return typeof id === 'string' ? id : id == null ? null : String(id);
  };
  const outcome = (handle: number, decision: Decision, status: MessageOutcome['status'], reason: string | null = null) =>
    outcomes.set(handle, { handle, messageId: messageIdOf(handle), decision, status, reason });

  for (const handle of plan.kept) outcome(handle, { kind: 'keep' }, 'kept');

  for (const { handle, decision } of plan.steps) {
    const message = messages.get(handle);
    const handler = handlerFor(decision);
    if (!handler) {
      outcome(
        handle,
        decision,
        'not-attempted',
        `${KIND_LABEL[decision.kind]} is not available yet in this version of Volverán. The Message goes back to the queue.`,
      );
      continue;
    }
    if (!message || !run.usable()) {
      outcome(handle, decision, 'not-attempted', 'The Checkout stopped being active before this Message; it is back in the queue.');
      continue;
    }

    let entryId: number;
    let details: AuditDetails;
    try {
      details = handler.audit(decision, message, target);
      entryId = audit.record({
        at: new Date(),
        operator: target.operator,
        role: target.role,
        approver: target.approver,
        brokerUser: target.brokerUser,
        profile: target.profile.name,
        vhost: target.vhost,
        queue: target.queue,
        messageId: messageIdOf(handle),
        action: details.action,
        reason: details.reason,
        destination: details.destination,
        checkoutId: target.checkoutId,
        replayId: details.replayId,
        message: {
          body: details.copy === 'full' ? message.content : null,
          properties: propertiesWithoutHeaders(message),
          headers: message.properties.headers ?? {},
        },
      });
    } catch (err) {
      outcome(handle, decision, 'failed', `Could not write the Audit Entry, so the Message was left in the queue: ${(err as Error).message}`);
      continue;
    }

    let result: StepResult;
    // The broker may or may not have carried the step out; a Restore must not assume either.
    let uncertain = false;
    try {
      await run.beforeStep?.(entryId);
      result = await handler.execute(decision, message, ctx, details);
    } catch (err) {
      uncertain = err instanceof AckUncertainError;
      result = { status: 'failed', reason: (err as Error).message };
    }
    if (result.status === 'done') run.onDone(handle);
    try {
      audit.setOutcome(entryId, uncertain ? 'uncertain' : result.status, result.status === 'failed' ? result.reason : null);
    } catch {
      // The entry stays `pending`; the outcome below is still reported.
    }
    outcome(handle, decision, result.status, result.status === 'failed' ? result.reason : null);
  }

  return [...messages.keys()].flatMap((handle) => {
    const o = outcomes.get(handle);
    return o ? [o] : [];
  });
}

function propertiesWithoutHeaders(message: HeldMessage): Record<string, unknown> {
  const { headers: _headers, ...properties } = message.properties;
  return Object.fromEntries(Object.entries(properties).filter(([, v]) => v !== undefined));
}
