// A queue's depth history, from the recording.
//
//   GET /profiles/{profile}/vhosts/{vhost}/queues/{queue}/history?from=&to= → QueueHistory (default: the last 24 hours)
//
// Each queue was recorded over 1 hour, 24 hours and 7 days; a request gets the
// recording closest to its length, cut to its range. A queue with no recording
// has an empty history, as an unsampled one has on the server.
import type { QueueHistory } from '../../../../src/shared/history.js';
import type { RecordedRange } from '../recording.js';
import { DemoApiError, json, type Router } from '../router.js';
import { vhostOf, type DemoState } from '../state.js';

const DAY_MS = 86_400_000;
const LENGTHS: Record<RecordedRange, number> = { '1h': 3_600_000, '24h': DAY_MS, '7d': 7 * DAY_MS };

export function registerHistoryRoutes(router: Router, state: DemoState, now: () => number) {
  router.on('GET', '/profiles/{profile}/vhosts/{vhost}/queues/{queue}/history', ({ params, query }) => {
    const vhost = vhostOf(state, params.profile!, params.vhost!);
    const to = parseTime('to', query.get('to')) ?? now();
    const from = parseTime('from', query.get('from')) ?? to - DAY_MS;
    if (from > to) throw invalid('"from" must not be after "to".');
    const recorded = vhost.histories[params.queue!];
    const anyRecorded = Object.values(vhost.histories)[0]?.['24h'];
    if (!recorded) {
      return json({
        from: iso(from),
        to: iso(to),
        retentionDays: anyRecorded?.retentionDays ?? 30,
        latestSampleAt: null,
        samples: [],
        gaps: [],
        marks: [],
      } satisfies QueueHistory);
    }
    const closest = (Object.keys(LENGTHS) as RecordedRange[]).reduce((best, r) =>
      Math.abs(LENGTHS[r] - (to - from)) < Math.abs(LENGTHS[best] - (to - from)) ? r : best,
    );
    const h = recorded[closest];
    const within = (at: string) => Date.parse(at) >= from && Date.parse(at) <= to;
    return json({
      ...h,
      from: iso(from),
      to: iso(to),
      samples: h.samples.filter((s) => within(s.at)),
      gaps: h.gaps
        .filter((g) => Date.parse(g.to) >= from && Date.parse(g.from) <= to)
        .map((g) => ({ ...g, from: iso(Math.max(Date.parse(g.from), from)), to: iso(Math.min(Date.parse(g.to), to)) })),
      marks: h.marks.filter((m) => within(m.at)),
    } satisfies QueueHistory);
  });
}

const iso = (ms: number) => new Date(ms).toISOString();

function parseTime(name: string, value: string | null): number | null {
  if (value === null || value.trim() === '') return null;
  const ms = Date.parse(value.trim());
  if (Number.isNaN(ms)) throw invalid(`"${name}" must be an ISO 8601 date-time, not "${value}".`);
  return ms;
}

function invalid(message: string) {
  return new DemoApiError(400, 'invalid_request', message);
}
