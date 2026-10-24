// Running a Checkout's Apply (ADR 0001): the Decisions carried out one
// Message at a time (apply/executor.ts), asking before every step whether
// the Checkout is still active. Replay and Move publish on a confirm channel
// of their own on the Checkout's connection (apply/publisher.ts, ADR 0006),
// so a publish error never closes the channel holding the Messages. The
// manager ends the Checkout afterwards.
import type * as amqp from 'amqplib';
import { executeApply } from '../apply/executor.js';
import { ConfirmPublisher } from '../apply/publisher.js';
import { AckUncertainError, type ApplyContext, type MessageOutcome } from '../apply/types.js';
import type { AuditStore } from '../audit/store.js';
import { queueRefOf } from '../profiles.js';
import { buildApplyPlan } from '../triage/decisions.js';
import type { Checkout } from './state.js';

export interface RunApplyOptions {
  audit: AuditStore;
  /** Test seam: an Apply step's `pending` Audit Entry is committed; next the step touches the broker. */
  beforeStep?(entryId: number): Promise<void>;
}

/**
 * Carries out every Decision of an active Checkout, removing each done
 * Message from `checkout.held`; `checkout.applying` is set while it runs.
 * Returns when it started and the outcome for each Message.
 */
export async function runApply(
  checkout: Checkout,
  options: RunApplyOptions,
): Promise<{ startedAt: Date; outcomes: MessageOutcome[] }> {
  // Opened on first use; closes with the Checkout's connection when the Checkout ends.
  let publisher: ConfirmPublisher | undefined;
  const ctx: ApplyContext = {
    target: { ...queueRefOf(checkout), checkoutId: checkout.id, operator: checkout.operator },
    startedAt: new Date(),
    ack: (message) => ack(checkout, message),
    publish: async (exchange, routingKey, content, publishOptions) => {
      if (!checkout.connection) return { ok: false, reason: 'The Checkout has no connection to the broker any more.' };
      publisher ??= new ConfirmPublisher(checkout.connection);
      return publisher.publish(exchange, routingKey, content, publishOptions);
    },
  };
  const running = executeApply({
    plan: buildApplyPlan([...checkout.held.keys()], checkout.decisions),
    messages: new Map(checkout.held),
    ctx,
    audit: options.audit,
    usable: () => checkout.status === 'active',
    beforeStep: options.beforeStep,
    onDone: (handle) => {
      checkout.held.delete(handle);
      checkout.decisions.delete(handle);
    },
  });
  checkout.applying = running;
  try {
    return { startedAt: ctx.startedAt, outcomes: await running };
  } finally {
    checkout.applying = null;
  }
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
