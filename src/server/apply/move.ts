// Move (ADR 0005): publish the Message to the destination the Operator
// picked, under the same rules as Replay (republish.ts: cleaned headers, a
// new replay id, x-volveran-from), then ack it. A queue is reached through
// the default exchange with its name as routing key, so it lands in exactly
// that queue; an exchange gets the Operator's routing key and delivers by its
// bindings. A destination the broker cannot route to at Apply time (deleted
// since the Decision, or no binding matches) makes the publish fail, and the
// Message falls back to Keep. The Audit Entry keeps the original properties
// and headers, not the body.
import { randomUUID } from 'node:crypto';
import { destinationLabel, type MoveDestination } from '../../shared/decisions.js';
import { publishHeld } from './publish-held.js';
import type { DecisionHandler } from './types.js';

/** The exchange and routing key a Move to `destination` publishes with. */
function route(destination: MoveDestination): { exchange: string; routingKey: string; queue: string | null } {
  return 'queue' in destination
    ? { exchange: '', routingKey: destination.queue, queue: destination.queue }
    : { exchange: destination.exchange, routingKey: destination.routingKey, queue: null };
}

export const move: DecisionHandler<{ kind: 'move'; destination: MoveDestination }> = {
  audit({ destination }) {
    return { action: 'move', reason: null, destination: route(destination), copy: 'headers', replayId: randomUUID() };
  },

  execute({ destination }, message, ctx, { replayId }) {
    const { exchange, routingKey } = route(destination);
    return publishHeld(
      ctx,
      message,
      exchange,
      routingKey,
      replayId!,
      (reason) =>
        `Could not Move the Message to ${destinationLabel(destination)} (does it still exist, and does it route the Message somewhere?): ${reason} It stays in the queue.`,
    );
  },
};
