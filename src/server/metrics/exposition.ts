// Pure (no I/O): the Prometheus text exposition format, written by hand so
// the project needs no metrics library. A module with something to expose
// hands over MetricFamily values; a counter it keeps itself is a MetricCounter.

export type MetricType = 'gauge' | 'counter';

/** One time series. A null or non-finite `value` means "unknown": the series is left out, never shown as 0. */
export interface MetricSeries {
  labels?: Record<string, string>;
  value: number | null;
}

export interface MetricFamily {
  name: string;
  help: string;
  type: MetricType;
  series: MetricSeries[];
}

/** The families as a scrape's body. A family with no series still has its HELP and TYPE. */
export function renderMetrics(families: readonly MetricFamily[]): string {
  const lines: string[] = [];
  for (const family of families) {
    lines.push(`# HELP ${family.name} ${escapeHelp(family.help)}`, `# TYPE ${family.name} ${family.type}`);
    for (const { labels, value } of family.series) {
      if (value === null || !Number.isFinite(value)) continue;
      lines.push(`${family.name}${renderLabels(labels)} ${value}`);
    }
  }
  return `${lines.join('\n')}\n`;
}

function renderLabels(labels: Record<string, string> = {}): string {
  const pairs = Object.entries(labels).map(([name, value]) => `${name}="${escapeLabelValue(value)}"`);
  return pairs.length === 0 ? '' : `{${pairs.join(',')}}`;
}

function escapeLabelValue(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
}

function escapeHelp(help: string): string {
  return help.replace(/\\/g, '\\\\').replace(/\n/g, '\\n');
}

/** A counter held in memory, one series per label set, reset by a restart as Prometheus expects. */
export class MetricCounter {
  private readonly counts = new Map<string, { labels: Record<string, string>; value: number }>();

  constructor(
    private readonly name: string,
    private readonly help: string,
  ) {}

  inc(labels: Record<string, string>, by = 1): void {
    const sorted = Object.fromEntries(Object.entries(labels).sort(([a], [b]) => (a < b ? -1 : 1)));
    const key = JSON.stringify(sorted);
    const count = this.counts.get(key);
    if (count) count.value += by;
    else this.counts.set(key, { labels: sorted, value: by });
  }

  family(): MetricFamily {
    return {
      name: this.name,
      help: this.help,
      type: 'counter',
      series: [...this.counts.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([, count]) => count),
    };
  }
}
