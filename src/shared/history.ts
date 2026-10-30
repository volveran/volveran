// A queue's depth history as the API sends it (src/server/routes/history.ts).
// Types only, shared by the server and the web app.

/** One point of a queue's history: a Sample, or a bucket of them when the range is long. */
export interface HistorySample {
  /** ISO 8601. */
  at: string;
  depth: number;
  /**
   * Messages that arrived since the point before: the rise in depth plus the
   * Messages Volverán took out. Null means unknown (a queue's first Sample),
   * never zero. Consumers outside Volverán hide arrivals.
   */
  estimatedArrivals: number | null;
  /** A bucket where some Samples, not all, have unknown arrivals: `estimatedArrivals` adds up the rest. */
  arrivalsPartlyUnknown: boolean;
}

/** A stretch with no Samples because sampling failed, or Volverán was not running. */
export interface HistoryGap {
  from: string;
  to: string;
  /** Why the last sampling run failed; null when runs were simply missing. */
  errorCode: string | null;
}

/** An Apply or a Rule Pass that took Messages out of the queue. */
export interface HistoryMark {
  /** When the last of its Messages was taken out. */
  at: string;
  kind: 'apply' | 'rule_pass';
  /** The Operator's name, or the rule's on a Rule Pass. */
  operator: string;
  /** The Replay Rule's name on a Rule Pass; null on an Apply. */
  rule: string | null;
  checkoutId: string;
  /** Messages taken out, by Decision. */
  counts: { discard: number; replay: number; move: number };
  /** The audit search that lists its Audit Entries on this queue. */
  auditUrl: string;
}

/** GET /api/profiles/:profile/vhosts/:vhost/queues/:queue/history */
export interface QueueHistory {
  from: string;
  to: string;
  /** How long Samples are kept (VOLVERAN_HISTORY_RETENTION_DAYS): the longest range worth asking for. */
  retentionDays: number;
  /** The time of the queue's latest Sample, in range or not; null when it has none. */
  latestSampleAt: string | null;
  samples: HistorySample[];
  gaps: HistoryGap[];
  marks: HistoryMark[];
}

/**
 * A dead-letter queue's last 24 hours in the queue list, small enough to send
 * for every listed queue: times are epoch milliseconds, and `points` holds at
 * most ~100 `[at, depth]` pairs, oldest first.
 */
export interface DepthSeries {
  from: number;
  to: number;
  points: Array<[at: number, depth: number]>;
  /** Stretches when the profile could not be sampled. */
  gaps: Array<{ from: number; to: number }>;
}
