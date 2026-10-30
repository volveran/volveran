// The metrics of triage, from what the Checkout manager and the Replay Rules tell them.
import { describe, expect, it } from 'vitest';
import { TriageMetrics } from '../../src/server/metrics/triage.js';
import type { RuleState } from '../../src/shared/replay-rules.js';

const paused = (pausedReason: string) => ({ paused: true, pausedReason }) as RuleState;

describe('volveran_replay_rule_paused', () => {
  it('cuts a long pause reason in its label to the same 500 characters as notifications', () => {
    const metrics = new TriageMetrics({
      ruleStates: () => [{ profile: 'p', rule: 'r', state: paused('y'.repeat(5000)) }],
      checkoutCounts: () => ({ active: 0, waitingApproval: 0 }),
      storedBodyBytes: () => 0,
    });
    const family = metrics.families().find((f) => f.name === 'volveran_replay_rule_paused')!;
    expect(family.series[0]!.labels!.reason).toBe('y'.repeat(500));
  });
});
