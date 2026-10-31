// Audit Entries as the API sends them (src/server/routes/audit.ts), shared
// by the server and the web app. Pure values and types (no Node or DOM APIs).
import type { Role } from './roles.js';
import type { Filter } from './filters.js';

/**
 * Every action an Audit Entry can record: the triage actions, and the pause
 * and resume of a Replay Rule (no Message; the Operator is the person, or the
 * rule itself for an automatic pause, and `reason` says why).
 */
export const AUDIT_ACTIONS = ['discard', 'replay', 'move', 'restore', 'export', 'rule_pause', 'rule_resume'] as const;

/** The action an Audit Entry records. */
export type AuditAction = (typeof AUDIT_ACTIONS)[number];

/**
 * pending: written before the broker was touched, never updated (the process
 * stopped mid-action: the Message may still be in the queue too). done /
 * failed: carried out / not carried out. uncertain: the broker may or may not
 * have carried it out (the connection dropped before it confirmed the ack).
 * An export is pending while its download is written, done once every line
 * is, failed when the download stopped part way.
 */
export type AuditOutcome = 'pending' | 'done' | 'failed' | 'uncertain';

/** How the watch of an Apply's Canary ended (CanaryStatus without `watching`). */
export type AuditCanaryOutcome = 'died_again' | 'not_dead_lettered' | 'watch_cut_short' | 'unwatched' | 'failed';

/** Where a Replay, Move or Restore published the Message. */
export interface AuditDestination {
  exchange: string;
  routingKey: string;
  /** The queue the Message was sent to, when one was named (Replay, Move to a queue, Restore); null for an exchange. */
  queue: string | null;
}

/** An Audit Entry as JSON; properties and headers in lossless AMQP JSON (src/server/audit/amqp-json.ts). */
export interface AuditEntryJson {
  id: number;
  /** ISO 8601. */
  at: string;
  operatorId: string;
  operatorName: string;
  /** The Operator's Role on the Broker Profile when they acted; null on entries written before v0.3. */
  role: Role | null;
  /** The Operator who approved the Apply that wrote the entry (Approval); null when it needed none. */
  approverId: string | null;
  approverName: string | null;
  /** The Broker Profile's RabbitMQ user. */
  brokerUser: string;
  profile: string;
  vhost: string;
  /** The queue the Message was taken from. */
  queue: string;
  messageId: string | null;
  action: AuditAction;
  reason: string | null;
  destination: AuditDestination | null;
  checkoutId: string | null;
  /** A Restore: the Discard's Audit Entry. */
  restoreOf: number | null;
  /** Replay, Move, Restore: the `x-volveran-replay-id` the Message was published with. */
  replayId: string | null;
  outcome: AuditOutcome;
  outcomeReason: string | null;
  /** Set once retention evicted the Discarded body ("body expired"). */
  bodyExpiredAt: string | null;
  /** An export: the filter its Messages matched; null when it exported every held Message. */
  filter: Filter | null;
  /** An export: how many Messages it holds; null for the other actions. */
  messageCount: number | null;
  /** The Replay Rate of the Apply that wrote the entry, in Messages per second; null when there is none, for other actions and before v0.4. */
  rate: number | null;
  /** The Replay Rule whose Rule Pass wrote the entry (its name; the Operator is then the rule); null for an Operator's actions and before v0.4. */
  rule: string | null;
  /** The Rule Pass that wrote the entry; null when no rule did. */
  rulePassId: string | null;
  /** The Replay an Apply carried out alone as its Canary, before the rest. */
  canary: boolean;
  /** The Canary's watch outcome; null for other entries, and while it is watched. */
  canaryOutcome: AuditCanaryOutcome | null;
  /** The Message acted on; null for an export, which keeps no copy. */
  message: {
    properties: Record<string, unknown>;
    headers: Record<string, unknown>;
    /** Size of the stored body; null when none was stored. */
    bodyBytes: number | null;
    /** Only on a single entry (GET /api/audit-entries/:id): base64, null once expired. */
    body?: string | null;
  } | null;
}

/** How full the store of Discarded bodies is (GET /api/audit-store). */
export interface BodyStoreUsage {
  storedBodyBytes: number;
  maxBodyBytes: number;
  maxAgeDays: number;
  /** Near the size limit: the oldest bodies will soon be evicted. */
  nearLimit: boolean;
}

/** A stored value as an Operator reads it: a NUL shows as a symbol, as a browser would draw it as nothing. */
export const showingNul = (text: string): string => text.replaceAll('\0', '\u2400');
