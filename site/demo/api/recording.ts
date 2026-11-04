// The real server's answers for the read-only views, recorded by the
// screenshot run from the same seeded broker as docs/images
// (scripts/screenshots/demo-recording.mjs writes docs/demo/recording.json).
// The demo serves them with every time moved forward to the moment it loads.
import type { AlertRuleView, AlertsOverview } from '../../../src/shared/alerts.js';
import type { DeadLetterMap } from '../../../src/shared/dead-letter-map.js';
import type { QueueHistory } from '../../../src/shared/history.js';
import type { MoveDestinations, ProfileSummary, QueueList } from '../../../src/shared/queues.js';
import type { ReplayRuleView } from '../../../src/shared/replay-rules.js';
import recorded from '../../../docs/demo/recording.json' with { type: 'json' };

/** The history ranges recorded per queue, as the web app offers them; its whole retention gets the longest. */
export type RecordedRange = '1h' | '24h' | '7d';

export interface RecordedVhost {
  name: string;
  /** The vhost's whole queue list, as GET .../queues answers it with no search. */
  queueList: QueueList;
  deadLetterMap: DeadLetterMap;
  moveDestinations: MoveDestinations;
  /** Each listed queue's history, over each recorded range ending when it was recorded. */
  histories: Record<string, Record<RecordedRange, QueueHistory>>;
}

export interface RecordedProfile {
  summary: ProfileSummary;
  alertRules: AlertRuleView[];
  replayRules: ReplayRuleView[];
  vhosts: RecordedVhost[];
}

export interface Recording {
  /** ISO 8601: when the screenshot run recorded it. */
  recordedAt: string;
  profiles: RecordedProfile[];
  alerts: AlertsOverview;
}

/** The committed recording, with its times moved to `now`. */
export function recording(now: number): Recording {
  return rebased(recorded as unknown as Recording, now);
}

/** A whole ISO 8601 UTC time, as the server writes them. */
const ISO_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;
/** Epoch milliseconds the API sends (depth series) lie between 2001 and 2286; no count or size in a recording does. */
const isEpochMs = (n: number) => Number.isInteger(n) && n >= 1e12 && n < 1e13;

/**
 * `value` with every time in it moved by `now - recordedAt`: whole ISO 8601 strings and epoch
 * milliseconds. Text that merely contains a time (a Message body) is left as it is.
 */
export function rebased<T extends { recordedAt: string }>(value: T, now: number): T {
  const shift = now - Date.parse(value.recordedAt);
  const move = (v: unknown): unknown => {
    if (typeof v === 'string') return ISO_TIME.test(v) ? new Date(Date.parse(v) + shift).toISOString() : v;
    if (typeof v === 'number') return isEpochMs(v) ? v + shift : v;
    if (Array.isArray(v)) return v.map(move);
    if (v !== null && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, move(x)]));
    return v;
  };
  return move(value) as T;
}
