import { describe, expect, it } from 'vitest';
import { shutdownLine } from '../../src/web/shutdown-line.js';

describe('the line on a Checkout ended by a shutdown', () => {
  it.each(['quorum', 'classic'] as const)('names the Replica shutting down and what to do next, on a %s queue', (queueType) => {
    expect(shutdownLine(queueType)).toMatch(/ended because the Volverán Replica holding it shut down/);
    expect(shutdownLine(queueType)).toMatch(/You can start another Checkout\.$/);
  });
});
