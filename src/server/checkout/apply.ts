// Running a Checkout's Apply (ADR 0001): the Decisions carried out one
// Message at a time (apply/executor.ts), asking before every step whether
// the Checkout is still active and whether the manager asked it to stop
// (the time limit, an Operator), and counting each step in the Checkout's Apply progress.
// Replay and Move steps are paced at the Apply's Replay Rate, if any.
// An approved Apply runs here too, on the
// requester's Checkout and connection, recorded as the requester's with the
// approver alongside. Replay and Move publish on a confirm channel
// of their own on the Checkout's connection (apply/publisher.ts, ADR 0006),
// so a publish error never closes the channel holding the Messages. The
// manager ends the Checkout afterwards.
import type * as amqp from 'amqplib';
import { executeApply, NOT_ACTIVE_REASON } from '../apply/executor.js';
import { ApplyProgressTracker } from '../apply/progress.js';
import { ConfirmPublisher } from '../apply/publisher.js';
import { permissionRefused } from '../broker-credentials.js';
import { AckUncertainError, type ApplyContext, type MessageOutcome, type RuleActing } from '../apply/types.js';
import type { AuditStore } from '../audit/store.js';
import { queueRefOf } from '../profiles.js';
import { buildApplyPlan } from '../triage/decisions.js';
import type { Checkout } from './state.js';
import type { Operator } from '../operator.js';
import type { Role } from '../../shared/roles.js';

export interface RunApplyOptions {
  audit: AuditStore;
  /** The Role of the Operator Applying (the requester, for an approved Apply), for the Audit Entries. */
  role: Role;
  /** The Operator who approved the Apply, for the Audit Entries; null when it needed no Approval. */
  approver: Pick<Operator, 'id' | 'displayName'> | null;
  /** A Rule Pass: the rule and pass, for the Audit Entries; null or left out for an Operator's Apply. */
  rule?: RuleActing | null;
  /** Asked before every step: null to go on, or why no further step is attempted (the time limit, an Operator's stop). */
  stopReason(): string | null;
  /** Aborted when the Apply is told to stop: a wait for the next paced step ends at once. */
  stopSignal?: AbortSignal;
  /** The Replay Rate in Messages per second; null when unthrottled. */
  rate: number | null;
  /** Test seam: an Apply step's `pending` Audit Entry is committed; next the step touches the broker. */
  beforeStep?(entryId: number): Promise<void>;
}

/**
 * Carries out every Decision of an active Checkout, removing each done
 * Message from `checkout.held`. Sets `checkout.applyProgress` before its
 * first await, and counts each step there as it settles. Returns when it
 * started and the outcome for each Message.
 */
export async function runApply(
  checkout: Checkout,
  options: RunApplyOptions,
): Promise<{ startedAt: Date; outcomes: MessageOutcome[] }> {
  // Opened on first use; closes with the Checkout's connection when the Checkout ends.
  let publisher: ConfirmPublisher | undefined;
  const ctx: ApplyContext = {
    target: {
      ...queueRefOf(checkout),
      checkoutId: checkout.id,
      operator: checkout.operator,
      role: options.role,
      brokerUser: checkout.brokerUser,
      approver: options.approver,
      rule: options.rule ?? null,
    },
    startedAt: new Date(),
    ack: (message) => ack(checkout, message),
    publish: async (exchange, routingKey, content, publishOptions) => {
      if (!checkout.connection) return { ok: false, reason: 'The Checkout has no connection to the broker any more.' };
      publisher ??= new ConfirmPublisher(
        checkout.connection,
        (refusedExchange) =>
          permissionRefused(
            checkout.profile,
            checkout.brokerUser,
            { type: 'exchange', name: refusedExchange, vhost: checkout.vhost },
            'write',
            'Replay and Move publish the Message, so the broker user needs write permission on that exchange.',
          ).message,
      );
      return publisher.publish(exchange, routingKey, content, publishOptions);
    },
  };
  const plan = buildApplyPlan([...checkout.held.keys()], checkout.decisions);
  const progress = new ApplyProgressTracker(plan.steps.length, ctx.startedAt, options.rate);
  checkout.applyProgress = progress;
  const outcomes = await executeApply({
    plan,
    messages: new Map(checkout.held),
    ctx,
    audit: options.audit,
    // A stop asked for first wins over the Checkout being lost afterwards.
    stopReason: () => options.stopReason() ?? (checkout.status === 'active' ? null : NOT_ACTIVE_REASON),
    rate: options.rate,
    stopSignal: options.stopSignal,
    onStep: (o) => {
      if (o.status !== 'kept') progress.record(o.status);
    },
    beforeStep: options.beforeStep,
    onDone: (handle) => {
      checkout.held.delete(handle);
      checkout.decisions.delete(handle);
    },
  });
  return { startedAt: ctx.startedAt, outcomes };
}

/**
 * Acks a held Message and waits until the broker has processed the ack (a
 * round trip on the same channel: the broker handles the ack before replying).
 */
async function ack(checkout: Checkout, message: amqp.ConsumeMessage): Promise<void> {
  const channel = checkout.channel;
  if (checkout.status !== 'active' || !channel) {
    throw new Error('The Checkout stopped being active, so the Message was left in the queue.');
  }
  try {
    channel.ack(message);
  } catch (err) {
    throw new Error(`Could not ack the Message, so it was left in the queue: ${(err as Error).message}`);
  }
  try {
    await channel.prefetch(Math.max(1, checkout.held.size));
  } catch (err) {
    throw new AckUncertainError((err as Error).message);
  }
}
