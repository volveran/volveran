// Keep at a Checkout's end (ADR 0006): every held Message goes back with a
// `nack` that puts it in the queue, one at a time in queue order, then the overflow. Unlike
// reject that uses up no Delivery Budget. But a quorum queue takes `nack`s through its Raft log,
// and closing the channel overtakes those still on their way, which does use it
// up. So on a quorum queue the channel stays open until a passive declare counts
// the Messages as ready (docs/rabbitmq-behaviour.md, "Returning Messages before
// closing").
//
// The count is only a sign: another consumer taking Messages keeps it short,
// which is why the wait has a time limit, and an arrival can bring it there
// early. Classic queues have no Delivery Budget, so they do not wait.
import type * as amqp from 'amqplib';
import { returnWaitMs } from '../triage/checkout-timing.js';
import type { Checkout } from './state.js';

const POLL_MS = 50;

export interface ReturnOptions {
  /** Overrides how long the wait may last (returnWaitMs). */
  waitMs?: number;
  /** The wait ran out, so closing the channel may use up Delivery Budget. */
  onWaitRanOut(waited: { returned: number; waitedMs: number }): void;
}

/** Returns what the Checkout holds. Rejects when the channel is gone: the broker has returned everything then. */
export async function returnMessages(checkout: Checkout, channel: amqp.Channel, options: ReturnOptions): Promise<void> {
  const messages = [...checkout.held.values(), ...checkout.overflow];
  if (checkout.queueType !== 'quorum' || messages.length === 0) {
    for (const m of messages) channel.nack(m, false, true);
    return;
  }
  // Sent ahead of the `nack`s on the same channel, and not awaited: a broker
  // that does not answer must still get them.
  const before = channel.checkQueue(checkout.queue);
  before.catch(() => {});
  for (const m of messages) channel.nack(m, false, true);

  const waitMs = options.waitMs ?? returnWaitMs(messages.length);
  let timer: NodeJS.Timeout | undefined;
  const ranOut = new Promise<'ran-out'>((resolve) => {
    timer = setTimeout(() => resolve('ran-out'), waitMs);
  });
  const waiting = { over: false };
  try {
    // The race, as a declare can go unanswered; a declare still out when it ends fails with the channel's close.
    const outcome = await Promise.race([allReady(channel, checkout.queue, before, messages.length, waiting), ranOut]);
    if (outcome === 'ran-out') options.onWaitRanOut({ returned: messages.length, waitedMs: waitMs });
  } finally {
    waiting.over = true;
    clearTimeout(timer);
  }
}

async function allReady(
  channel: amqp.Channel,
  queue: string,
  before: Promise<amqp.Replies.AssertQueue>,
  returned: number,
  waiting: { over: boolean },
): Promise<'ready'> {
  const target = (await before).messageCount + returned;
  while (!waiting.over && (await channel.checkQueue(queue)).messageCount < target) {
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }
  return 'ready';
}
