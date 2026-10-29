// Apply executor (ADR 0001): carries out an Apply plan within a Checkout, one
// Message at a time. Each step is independent and there is no rollback: a
// failed step leaves its Message held, so it falls back to Keep.
//
// Before every step it asks whether to go on (`stopReason`): once told to
// stop (a Lost Checkout, whose Messages the broker has already put back, or
// the Checkout's time limit), the remaining steps are not attempted, with the
// reason given. A step in progress always finishes. Each step's outcome is
// reported as it settles (`onStep`), for the Apply's progress.
//
// With a Canary, its step is carried out first and alone: the executor waits
// for the Canary's hooks (checkout/canary.ts) to let it go on, then asks
// whether to go on as before every step, and carries out the rest in order.
//
// With a Replay Rate, Replay and Move steps start at least 1/rate apart
// (pacing.ts); Discards are not paced. The wait comes between steps, before
// asking whether to go on, and a stop (`stopSignal`) cuts it short.
//
// For every attempted step an Audit Entry is written as `pending` (for a
// Discard, with the full Message, in a durable commit) before the broker is
// touched, then updated with the outcome. A crash in between leaves the
// Message in the queue *and* in the store: a duplicate, never a loss.
import type { AuditStore } from '../audit/store.js';
import type { ActionDecision, ApplyPlan, Decision } from '../triage/decisions.js';
import { handlerFor } from './handlers.js';
import { pacer } from './pacing.js';
import { AckUncertainError, type ApplyContext, type AuditDetails, type HeldMessage, type MessageOutcome, type StepResult } from './types.js';

const KIND_LABEL: Record<ActionDecision['kind'], string> = { discard: 'Discard', replay: 'Replay', move: 'Move' };
/** The reason of a step not attempted because the Checkout stopped being active (a Lost Checkout). */
export const NOT_ACTIVE_REASON = 'The Checkout stopped being active before this Message; it is back in the queue.';

export interface ApplyRun {
  plan: ApplyPlan;
  /** The Messages of the Checkout, by handle, in Checkout order. */
  messages: ReadonlyMap<number, HeldMessage>;
  ctx: ApplyContext;
  audit: AuditStore;
  /**
   * Asked before every step: null to carry it out, or why no further step is
   * attempted (the Checkout stopped being active, reached its time limit),
   * which becomes the reason of each step left.
   */
  stopReason(): string | null;
  /** The Replay Rate in Messages per second, recorded on every Audit Entry; null or left out when there is none. */
  rate?: number | null;
  /** Aborted when the Apply is told to stop, so a wait for the next paced step ends at once. */
  stopSignal?: AbortSignal;
  /** Called as each step settles (done, failed or not attempted), in plan order. */
  onStep?(outcome: MessageOutcome): void;
  /** Called as soon as a step is done, so its Message is no longer treated as held. */
  onDone(handle: number): void;
  /** Test seam: awaited after a step's `pending` Audit Entry is written, before the step touches the broker. */
  beforeStep?(entryId: number): Promise<void>;
  /** The Canary (a Replay step of the plan), carried out first and alone; its Audit Entry is marked as the Canary. */
  canary?: {
    handle: number;
    /** Awaited after the Canary's `pending` Audit Entry is written, before it is published with `replayId`. */
    beforePublish(entryId: number, replayId: string | null): Promise<void>;
    /** Awaited once the Canary's step was attempted and settled; the rest waits until it resolves. */
    afterStep(outcome: MessageOutcome): Promise<void>;
  };
}

/** Runs the plan; returns one outcome per Message of the plan, in Checkout order. */
export async function executeApply(run: ApplyRun): Promise<MessageOutcome[]> {
  const { plan, messages, ctx, audit } = run;
  const { target } = ctx;
  const rate = run.rate ?? null;
  const pace = pacer(rate);
  const outcomes = new Map<number, MessageOutcome>();
  const messageIdOf = (handle: number) => {
    const id = messages.get(handle)?.properties.messageId;
    return typeof id === 'string' ? id : id == null ? null : String(id);
  };
  const outcome = (handle: number, decision: Decision, status: MessageOutcome['status'], reason: string | null = null, refused = false) => {
    const o: MessageOutcome = { handle, messageId: messageIdOf(handle), decision, status, reason, ...(refused && { refused: true }) };
    outcomes.set(handle, o);
    if (status !== 'kept') run.onStep?.(o);
  };

  for (const handle of plan.kept) outcome(handle, { kind: 'keep' }, 'kept');

  const canary = run.canary;
  const steps = canary
    ? [...plan.steps.filter((s) => s.handle === canary.handle), ...plan.steps.filter((s) => s.handle !== canary.handle)]
    : plan.steps;
  for (const { handle, decision } of steps) {
    const isCanary = handle === canary?.handle;
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
    if (message && decision.kind !== 'discard') await pace.wait(run.stopSignal);
    const stop = message ? run.stopReason() : NOT_ACTIVE_REASON;
    if (!message || stop !== null) {
      outcome(handle, decision, 'not-attempted', stop ?? NOT_ACTIVE_REASON);
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
        rate,
        rule: target.rule?.name ?? null,
        rulePassId: target.rule?.passId ?? null,
        canary: isCanary,
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
      if (isCanary) await canary.beforePublish(entryId, details.replayId);
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
    outcome(
      handle,
      decision,
      result.status,
      result.status === 'failed' ? result.reason : null,
      result.status === 'failed' && result.refused === true,
    );
    if (isCanary) await canary.afterStep(outcomes.get(handle)!);
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
