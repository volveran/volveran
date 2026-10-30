// The metrics of dead-letter queues and of sampling, from the queue sampler and
// never from a broker. The gauges are read at each scrape from its latest
// snapshot, so they keep their last values while a broker is down. The arrivals
// counter adds up each run's Samples, not the snapshot: the snapshot keeps its
// Samples after a failed run and would count them twice.
import type { FinishedRun, LatestSample, LatestSnapshot } from '../history/sampler.js';
import { MetricCounter, type MetricFamily, type MetricSeries } from './exposition.js';

export class QueueMetrics {
  private readonly arrivals = new MetricCounter(
    'volveran_dead_letter_queue_estimated_arrived_messages_total',
    'Estimated Messages that arrived in a dead-letter queue since the process started: rises in depth plus the Messages Volverán took out. Consumers outside Volverán hide arrivals. No series while arrivals are unknown.',
  );

  constructor(private readonly latest: () => LatestSnapshot) {}

  /** One sampling run was recorded. */
  runFinished({ samples }: FinishedRun): void {
    for (const { profile, vhost, queue, estimatedArrivals } of samples) {
      if (estimatedArrivals !== null) this.arrivals.inc({ profile, vhost, queue }, estimatedArrivals);
    }
  }

  families(): MetricFamily[] {
    const { profiles } = this.latest();
    const queues = profiles.flatMap((p) => p.queues);
    return [
      {
        name: 'volveran_dead_letter_queue_messages',
        help: 'Messages waiting in a dead-letter queue at its latest Sample.',
        type: 'gauge',
        series: queues.map(({ profile, vhost, queue, depth }) => ({ labels: { profile, vhost, queue }, value: depth })),
      },
      this.arrivals.family(),
      {
        name: 'volveran_dead_letter_queue_setup_warnings',
        help: 'Set-up warnings of a dead-letter queue at its latest Sample, by code and severity. No series for a code it does not have.',
        type: 'gauge',
        series: queues.flatMap(warningSeries),
      },
      {
        name: 'volveran_sampling_up',
        help: 'Whether the latest sampling run of a Broker Profile succeeded (1) or failed (0).',
        type: 'gauge',
        series: profiles.map(({ profile, lastRun }) => ({ labels: { profile }, value: lastRun && (lastRun.ok ? 1 : 0) })),
      },
      {
        name: 'volveran_sampling_last_success_timestamp_seconds',
        help: 'When a Broker Profile was last sampled successfully, in seconds since the Unix epoch.',
        type: 'gauge',
        series: profiles.map(({ profile, lastSuccessAt }) => ({ labels: { profile }, value: lastSuccessAt && lastSuccessAt.getTime() / 1000 })),
      },
    ];
  }
}

function warningSeries({ profile, vhost, queue, setupWarnings }: LatestSample): MetricSeries[] {
  const series = new Map<string, MetricSeries & { value: number }>();
  for (const { code, severity } of setupWarnings) {
    const key = `${code}\n${severity}`;
    const known = series.get(key);
    if (known) known.value += 1;
    else series.set(key, { labels: { profile, vhost, queue, code, severity }, value: 1 });
  }
  return [...series.values()];
}
