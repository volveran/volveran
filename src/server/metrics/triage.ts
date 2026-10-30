// The metrics of triage: Replay rules, Apply outcomes, Checkouts, Approvals
// and the audit store's stored bodies. The two counters are told by the
// Checkout manager and the Replay Rules as things happen; the gauges are read
// at each scrape from the manager and from the audit store's rule state and
// body sizes, never from a broker.
import type { MessageOutcome } from '../apply/types.js';
import { MetricCounter, type MetricFamily } from './exposition.js';
import type { RulePassStatus, RuleState } from '../../shared/replay-rules.js';

export interface TriageReadings {
  ruleStates(): Array<{ profile: string; rule: string; state: RuleState }>;
  checkoutCounts(): { active: number; waitingApproval: number };
  storedBodyBytes(): number;
}

export class TriageMetrics {
  private readonly passes = new MetricCounter('volveran_replay_rule_passes_total', 'Rule Passes since the process started, by result.');
  private readonly applied = new MetricCounter(
    'volveran_apply_messages_total',
    'Messages an Apply acted on since the process started, by Decision and outcome. Kept Messages are not counted.',
  );

  constructor(private readonly readings: TriageReadings) {}

  /** One Rule Pass was recorded. */
  passRecorded(profile: string, rule: string, result: RulePassStatus): void {
    this.passes.inc({ profile, rule, result });
  }

  /** An Apply (an Operator's, or a Rule Pass's) ended with these outcomes. */
  applyEnded(profile: string, outcomes: readonly MessageOutcome[]): void {
    for (const { decision, status } of outcomes) {
      if (status !== 'kept') this.applied.inc({ profile, decision: decision.kind, outcome: status });
    }
  }

  families(): MetricFamily[] {
    const { active, waitingApproval } = this.readings.checkoutCounts();
    return [
      {
        name: 'volveran_replay_rule_paused',
        help: 'Whether a Replay rule is paused (1) or running (0), with the reason it is paused.',
        type: 'gauge',
        series: this.readings.ruleStates().map(({ profile, rule, state }) => ({
          labels: { profile, rule, reason: state.pausedReason ?? '' },
          value: state.paused ? 1 : 0,
        })),
      },
      this.passes.family(),
      this.applied.family(),
      { name: 'volveran_checkouts_active', help: 'Active Checkouts.', type: 'gauge', series: [{ value: active }] },
      { name: 'volveran_approvals_waiting', help: 'Checkouts waiting for Approval.', type: 'gauge', series: [{ value: waitingApproval }] },
      {
        name: 'volveran_audit_store_body_bytes',
        help: 'Bytes of Discarded Message bodies kept in the audit store.',
        type: 'gauge',
        series: [{ value: this.readings.storedBodyBytes() }],
      },
    ];
  }
}
