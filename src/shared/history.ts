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
  /** The time of the queue's latest Sample, in range or not; null when it has none. */
  latestSampleAt: string | null;
  samples: HistorySample[];
  gaps: HistoryGap[];
  marks: HistoryMark[];
}


/** Where a queue's history is in the web app, from the root; its parts travel in the URL fragment, like an Approval's link. */
export function queueHistoryPath(profile: string, vhost: string, queue: string): string {
  return `/#/history/${[profile, vhost, queue].map(encodeURIComponent).join('/')}`;
}
