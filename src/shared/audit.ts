// Audit Entries as the API sends them (src/server/routes/audit.ts), shared
// by the server and the web app. Pure values and types (no Node or DOM APIs).
import type { Role } from './roles.js';

/** Every triage action an Audit Entry can record. */
export const AUDIT_ACTIONS = ['discard', 'replay', 'move', 'restore'] as const;

/** The triage action an Audit Entry records. */
export type AuditAction = (typeof AUDIT_ACTIONS)[number];

/**
 * pending: written before the broker was touched, never updated (the process
 * stopped mid-action: the Message may still be in the queue too). done /
 * failed: carried out / not carried out. uncertain: the broker may or may not
 * have carried it out (the connection dropped before it confirmed the ack).
 */
export type AuditOutcome = 'pending' | 'done' | 'failed' | 'uncertain';

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
