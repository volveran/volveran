// A queue's depth history: depth and estimated arrival rate over a range, as
// inline SVG. Gaps stay gaps and unknown arrivals stay unknown, never a flat
// line or a zero. Marks show the Applies and Rule Passes that took Messages
// out, each linking to its Audit Entries. Each chart has a text summary, and
// everything a chart shows on hover is also listed as text and reachable by
// keyboard. `Sparkline` is the queue list's small chart of the same data.
import { useEffect, useRef, useState } from 'react';
import { auditViewPath, type HistoryTarget } from '../shared/history-link.js';
import { api, ApiError, type DepthSeries, type HistoryMark, type QueueHistory } from './api.js';
import { ErrorBox } from './ErrorBox.js';
import {
  arrivalRates,
  arrivalsSummary,
  chartSegments,
  depthSummary,
  isDot,
  niceMax,
  placeMarks,
  rangeMs,
  timeX,
  unknownArrivalBands,
  valueY,
  type ChartPoint,
  type HistoryRange,
  type TimeScale,
} from './history-chart.js';

const CHART = { width: 720, height: 140, left: 44, right: 8, top: 8, bottom: 20 };
const PLOT_WIDTH = CHART.width - CHART.left - CHART.right;
const PLOT_HEIGHT = CHART.height - CHART.top - CHART.bottom;

/** Until a first answer says how long history is kept (the server's default). */
const DEFAULT_RETENTION_DAYS = 14;

const formatTime = (at: number | string) => new Date(at).toLocaleString();

function linePath(points: readonly ChartPoint[], scale: TimeScale, max: number, height: number): string {
  return points.map((p, i) => `${i === 0 ? 'M' : 'L'}${timeX(p.at, scale).toFixed(1)} ${valueY(p.value!, max, height).toFixed(1)}`).join(' ');
}

/** The lines, with a lone point between two breaks as a dot. */
function Line({ points, gaps, scale, max, height, dot }: { points: readonly ChartPoint[]; gaps: Array<{ from: number; to: number }>; scale: TimeScale; max: number; height: number; dot: number }) {
  return (
    <>
      {chartSegments(points, gaps).map((segment) =>
        isDot(segment, scale) ? (
          <circle key={segment[0]!.at} className="chart-line-dot" cx={timeX(segment.at(-1)!.at, scale)} cy={valueY(segment.at(-1)!.value!, max, height)} r={dot} />
        ) : (
          <path key={segment[0]!.at} className="chart-line" d={linePath(segment, scale, max, height)} />
        ),
      )}
    </>
  );
}

function Bands({ bands, className, fill, scale, height, label }: { bands: Array<{ from: number; to: number; title?: string }>; className: string; fill?: string; scale: TimeScale; height: number; label?: string }) {
  return (
    <>
      {bands.map((b) => {
        const x = timeX(Math.max(b.from, scale.from), scale);
        const width = Math.max(2, timeX(Math.min(b.to, scale.to), scale) - x);
        return (
          <rect key={`${b.from}-${b.to}`} className={className} fill={fill} x={x} y={0} width={width} height={height}>
            {(b.title ?? label) && <title>{b.title ?? label}</title>}
          </rect>
        );
      })}
    </>
  );
}

function HistoryChart({
  title,
  unit,
  summary,
  points,
  history,
  unknown,
}: {
  title: string;
  unit: string;
  summary: string;
  points: ChartPoint[];
  history: QueueHistory;
  unknown?: Array<{ from: number; to: number }>;
}) {
  const scale: TimeScale = { from: Date.parse(history.from), to: Date.parse(history.to), width: PLOT_WIDTH };
  const max = niceMax(points.flatMap((p) => (p.value === null ? [] : [p.value])));
  const gaps = history.gaps.map((g) => ({
    from: Date.parse(g.from),
    to: Date.parse(g.to),
    title: `Not sampled: ${g.errorCode ?? 'Volverán was not sampling'}`,
  }));
  return (
    <figure className="history-chart">
      <figcaption>
        <strong>{title}</strong> <small className="muted">{unit}</small>
      </figcaption>
      <svg viewBox={`0 0 ${CHART.width} ${CHART.height}`} aria-hidden="true">
        <g transform={`translate(${CHART.left} ${CHART.top})`}>
          <line className="chart-axis" x1={0} x2={PLOT_WIDTH} y1={PLOT_HEIGHT} y2={PLOT_HEIGHT} />
          <line className="chart-axis" x1={0} x2={0} y1={0} y2={PLOT_HEIGHT} />
          <text className="chart-label" x={-6} y={8} textAnchor="end">{max}</text>
          <text className="chart-label" x={-6} y={PLOT_HEIGHT} textAnchor="end">0</text>
          <text className="chart-label" x={0} y={PLOT_HEIGHT + 15}>{formatTime(scale.from)}</text>
          <text className="chart-label" x={PLOT_WIDTH} y={PLOT_HEIGHT + 15} textAnchor="end">{formatTime(scale.to)}</text>
          <Bands bands={gaps} className="chart-gap" scale={scale} height={PLOT_HEIGHT} />
          {unknown && (
            <defs>
              <pattern id="chart-unknown-hatch" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
                <line className="chart-unknown-stroke" x1="0" x2="0" y1="0" y2="6" />
              </pattern>
            </defs>
          )}
          {unknown && <Bands bands={unknown} className="chart-unknown" fill="url(#chart-unknown-hatch)" scale={scale} height={PLOT_HEIGHT} label="Arrivals unknown" />}
          <Line points={points} gaps={gaps} scale={scale} max={max} height={PLOT_HEIGHT} dot={2.5} />
          {placeMarks(history.marks, scale).map(({ mark, x }) => (
            // Mouse only: the list of marks under the charts has the same links for the keyboard.
            <a key={mark.checkoutId} href={auditViewPath(mark.auditUrl)} tabIndex={-1}>
              <title>{markText(mark)}</title>
              <line className="chart-mark" x1={x} x2={x} y1={0} y2={PLOT_HEIGHT} />
              <path className="chart-mark-head" d={`M${x - 4} 0 L${x + 4} 0 L${x} 6 Z`} />
            </a>
          ))}
        </g>
      </svg>
      <p className="chart-summary">{summary}</p>
    </figure>
  );
}

function markCounts(mark: HistoryMark): string {
  const { discard, replay, move } = mark.counts;
  return [
    discard > 0 && `${discard} Discarded`,
    replay > 0 && `${replay} Replayed`,
    move > 0 && `${move} Moved`,
  ]
    .filter(Boolean)
    .join(', ');
}

function markOrigin(mark: HistoryMark): string {
  return mark.kind === 'rule_pass' ? `Rule Pass of ${mark.rule}` : `Apply by ${mark.operator}`;
}

function markText(mark: HistoryMark): string {
  return `${markOrigin(mark)}: ${markCounts(mark)}`;
}

const RANGE_CHOICES: Array<{ range: HistoryRange; label(retentionDays: number): string }> = [
  { range: '1h', label: () => '1 hour' },
  { range: '24h', label: () => '24 hours' },
  { range: '7d', label: () => '7 days' },
  { range: 'retention', label: (days) => `Whole retention (${days} days)` },
];

export function HistoryView({ target, onBack }: { target: HistoryTarget; onBack(): void }) {
  const { profile, vhost, queue } = target;
  const [range, setRange] = useState<HistoryRange>('24h');
  const [retentionDays, setRetentionDays] = useState(DEFAULT_RETENTION_DAYS);
  const [history, setHistory] = useState<QueueHistory>();
  const [error, setError] = useState<ApiError>();
  const [loading, setLoading] = useState(false);
  const [tick, setTick] = useState(0);
  const heading = useRef<HTMLHeadingElement>(null);

  // Opening the view moves the keyboard here, so Tab goes on to its controls.
  useEffect(() => heading.current?.focus(), [profile, vhost, queue]);

  // Only the whole-retention range depends on the setting the first answer brings.
  const rangeLength = rangeMs(range, retentionDays);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    const to = Date.now();
    api
      .queueHistory(profile, vhost, queue, {
        from: new Date(to - rangeLength).toISOString(),
        to: new Date(to).toISOString(),
      })
      .then((answer) => {
        if (cancelled) return;
        setHistory(answer);
        setRetentionDays(answer.retentionDays);
        setError(undefined);
      })
      .catch((err) => {
        if (cancelled) return;
        setHistory(undefined);
        setError(err);
      })
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [profile, vhost, queue, rangeLength, tick]);

  const samples = (history?.samples ?? []).map((s) => ({ ...s, at: Date.parse(s.at) }));

  return (
    <section className="history">
      <p>
        <button type="button" className="link" onClick={onBack}>
          ← Back to queues
        </button>
      </p>
      <h2 ref={heading} tabIndex={-1}>
        Depth history of {queue}
      </h2>
      <p className="muted">
        Broker Profile {profile} · vhost {vhost}
      </p>

      {error?.code === 'history_not_sampled' ? (
        <p className="notice" role="note">
          {error.message}
        </p>
      ) : (
        <>
          <div className="controls" role="group" aria-label="Range">
            {RANGE_CHOICES.map((choice) => (
              <button key={choice.range} type="button" aria-pressed={range === choice.range} onClick={() => setRange(choice.range)}>
                {choice.label(retentionDays)}
              </button>
            ))}
            <button type="button" onClick={() => setTick((n) => n + 1)} disabled={loading}>
              Refresh
            </button>
          </div>
          {error && <ErrorBox error={error} />}
        </>
      )}

      {history && (
        <>
          <p role="status">
            {history.latestSampleAt
              ? `Latest Sample: ${formatTime(history.latestSampleAt)}`
              : history.gaps.length > 0
                ? 'No Samples yet: sampling this Broker Profile is failing, see below.'
                : 'No Samples yet: the first comes one sampling interval after Volverán starts.'}
          </p>
          <HistoryChart
            title="Depth"
            unit="Messages waiting"
            summary={depthSummary(samples.map((s) => s.depth), history.latestSampleAt ? Date.parse(history.latestSampleAt) : null, formatTime)}
            points={samples.map((s) => ({ at: s.at, value: s.depth }))}
            history={history}
          />
          <HistoryChart
            title="Estimated arrival rate"
            unit="Messages per minute"
            summary={arrivalsSummary(samples)}
            points={arrivalRates(samples)}
            history={history}
            unknown={unknownArrivalBands(samples)}
          />
          <p className="muted">
            Estimated: the rise in depth plus the Messages Volverán took out, because the broker does not count dead-lettered Messages. Consumers outside Volverán hide arrivals, and
            hatched stretches are unknown, wholly or in part, not zero. Management statistics lag by a few seconds, so a take-out can show as a brief false rise.
          </p>

          <h3>Taken out by triage</h3>
          {history.marks.length === 0 ? (
            <p className="empty">No Applies or Rule Passes took Messages out in this range.</p>
          ) : (
            <ul className="history-marks">
              {[...history.marks].reverse().map((mark) => (
                <li key={mark.checkoutId}>
                  {formatTime(mark.at)}: {markOrigin(mark)}, {markCounts(mark)}. <a href={auditViewPath(mark.auditUrl)}>Audit Entries</a>
                </li>
              ))}
            </ul>
          )}

          {history.gaps.length > 0 && (
            <>
              <h3>Not sampled</h3>
              <ul className="history-gaps">
                {history.gaps.map((gap) => (
                  <li key={gap.from}>
                    {formatTime(gap.from)} to {formatTime(gap.to)}: {gap.errorCode ?? 'Volverán was not sampling'}
                  </li>
                ))}
              </ul>
            </>
          )}
        </>
      )}
    </section>
  );
}

const SPARK = { width: 96, height: 24, pad: 2 };
const SPARK_PLOT_WIDTH = SPARK.width - 2 * SPARK.pad;

/** The queue list's 24-hour chart, with its text summary for screen readers. */
export function Sparkline({ series }: { series: DepthSeries }) {
  // Inset, so the latest Sample's dot at the right edge is not cut in half.
  const scale: TimeScale = { from: series.from, to: series.to, width: SPARK_PLOT_WIDTH };
  const points = series.points.map(([at, depth]) => ({ at, value: depth }));
  const max = niceMax(series.points.map(([, depth]) => depth));
  const plot = SPARK.height - 2 * SPARK.pad;
  const latest = series.points.at(-1)?.[0] ?? null;
  return (
    <>
      <svg className="sparkline" viewBox={`0 0 ${SPARK.width} ${SPARK.height}`} width={SPARK.width} height={SPARK.height} aria-hidden="true">
        <g transform={`translate(${SPARK.pad} ${SPARK.pad})`}>
          <Bands bands={series.gaps} className="chart-gap" scale={scale} height={plot} />
          <Line points={points} gaps={series.gaps} scale={scale} max={max} height={plot} dot={1.5} />
        </g>
      </svg>
      <span className="sr-only">
        Last 24 hours. {depthSummary(series.points.map(([, depth]) => depth), latest, formatTime)}
      </span>
    </>
  );
}
