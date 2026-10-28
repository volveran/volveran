// Sending a held Message somewhere else (Replay, Move): republish it with the
// rules of republish.ts through ApplyContext.publish, and ack it on the
// Checkout channel only once the broker has confirmed the publish (ADR 0006).
// Any failure before the ack leaves it held, so it falls back to Keep.
import { republishOptions } from './republish.js';
import { AckUncertainError, type ApplyContext, type HeldMessage, type StepResult } from './types.js';

/**
 * Republishes `message` to `exchange` / `routingKey` with cleaned headers and
 * `replayId` (new for every publish, already recorded in its Audit Entry),
 * then acks it. `describe` turns a publish failure into the
 * reason reported to the Operator. An ack the broker may or may not have
 * processed throws AckUncertainError.
 */
export async function publishHeld(
  ctx: ApplyContext,
  message: HeldMessage,
  exchange: string,
  routingKey: string,
  replayId: string,
  describe: (reason: string) => string = (reason) => reason,
): Promise<StepResult> {
  const options = republishOptions(message.properties, { replayId, from: ctx.target.queue });
  const published = await ctx.publish(exchange, routingKey, message.content, options);
  if (!published.ok) {
    // A refusal names the missing permission itself; the destination's own description would mislead.
    const reason = published.refused ? `${published.reason} It stays in the queue.` : describe(published.reason);
    return { status: 'failed', reason };
  }
  try {
    await ctx.ack(message);
  } catch (err) {
    // The broker may already have removed it from the source: the executor records that as uncertain.
    if (err instanceof AckUncertainError) {
      throw new AckUncertainError(err.causeText, 'The Message was published to its destination, so it is there now.');
    }
    return {
      status: 'failed',
      reason: `The Message was published but could not be removed from "${ctx.target.queue}", so it is now in both places: ${(err as Error).message}`,
    };
  }
  return { status: 'done' };
}
