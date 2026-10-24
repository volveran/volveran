// Replay (ADR 0005): publish the Message through the default exchange to the
// queue named in its most recent x-death entry (the queue that dead-lettered
// it, so only the consumer that failed sees it again), with the dead-letter
// and routing headers removed (republish.ts), then ack it. The Audit Entry
// keeps the original properties and headers, not the body.
import { randomUUID } from 'node:crypto';
import { replayOrigin } from '../triage/replay-origin.js';
import { publishHeld } from './publish-held.js';
import type { DecisionHandler } from './types.js';

export const replay: DecisionHandler<{ kind: 'replay' }> = {
  audit(_decision, message) {
    const origin = replayOrigin(message.properties.headers);
    return {
      action: 'replay',
      reason: null,
      destination: origin.ok ? { exchange: '', routingKey: origin.queue, queue: origin.queue } : null,
      copy: 'headers',
      replayId: randomUUID(),
    };
  },

  async execute(_decision, message, ctx, { replayId }) {
    const origin = replayOrigin(message.properties.headers);
    if (!origin.ok) return { status: 'failed', reason: origin.reason };
    return publishHeld(
      ctx,
      message,
      '',
      origin.queue,
      replayId!,
      (reason) => `Could not Replay the Message to "${origin.queue}" (does the queue still exist?): ${reason} It stays in the queue.`,
    );
  },
};
