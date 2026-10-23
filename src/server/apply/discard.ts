// Discard: ack the Message, keeping a full copy in its Audit Entry (the
// executor writes it, durably, before execute runs: ADR 0001).
import type { DecisionHandler } from './types.js';

export const discard: DecisionHandler<{ kind: 'discard'; reason: string }> = {
  audit: (decision) => ({ action: 'discard', reason: decision.reason, destination: null, copy: 'full', replayId: null }),

  async execute(_decision, message, ctx) {
    await ctx.ack(message);
    return { status: 'done' };
  },
};
