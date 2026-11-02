// The metrics of being one Replica among others: whether this one is the Background
// Leader, which also says whose shared-state gauges to read, and the partial failures it
// has seen. Each is this process's own, so a sum across Replicas is right.
import type { ForwardingFailure } from '../replicas/forwarding.js';
import { MetricCounter, type MetricFamily } from './exposition.js';

export class ReplicaMetrics {
  private readonly forwardingFailures = new MetricCounter(
    'volveran_forwarding_failures_total',
    'Requests between Replicas that failed since the process started, by reason.',
  );
  private readonly storeErrors = new MetricCounter('volveran_audit_store_errors_total', 'Calls to the audit store that failed since the process started.');

  constructor(private readonly isLeader: () => boolean) {}

  forwardingFailed(reason: ForwardingFailure): void {
    this.forwardingFailures.inc({ reason });
  }

  storeFailed(): void {
    this.storeErrors.inc({});
  }

  families(): MetricFamily[] {
    return [
      {
        name: 'volveran_background_leader',
        help: 'Whether this Replica is the Background Leader (1) or not (0). Only the leader shows the gauges of shared state.',
        type: 'gauge',
        series: [{ value: this.isLeader() ? 1 : 0 }],
      },
      this.forwardingFailures.family(),
      this.storeErrors.family(),
    ];
  }
}
