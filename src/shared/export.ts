// One line of a Checkout's NDJSON export (POST /api/checkouts/:id/export,
// src/server/triage/export-line.ts). Types only; the format is documented in
// the README ("Exporting Messages").
import type { DeliveryBudget, RenderedBody, XDeathEntry } from './checkout.js';
import type { Decision } from './decisions.js';

/** The version of the line format; a line that changes meaning gets a new one. */
export const EXPORT_LINE_VERSION = 1;

export interface ExportLine {
  v: typeof EXPORT_LINE_VERSION;
  /** Where the Message stood in the Checkout, 1 being the head of the queue (a filtered export keeps these). */
  position: number;
  messageId: string | null;
  /** The exchange and routing key the Message was delivered with (the dead-letter exchange's, for a dead-lettered one). */
  exchange: string;
  routingKey: string;
  /** Every AMQP property that is set, except headers, in the lossless AMQP JSON of Audit Entries. */
  properties: Record<string, unknown>;
  /** The headers in the lossless AMQP JSON of Audit Entries. */
  headers: Record<string, unknown>;
  /** The body as sent, base64. */
  body: string;
  /** How the Message view shows the body. */
  bodyKind: RenderedBody['kind'];
  /** The decoded `x-death` history, most recent first. */
  xDeath: XDeathEntry[];
  /** Quorum queues with a delivery limit only; null otherwise. */
  deliveryBudget: DeliveryBudget | null;
  /** The Message's Decision when it was exported (Keep until told otherwise). */
  decision: Decision;
  /** Set when the Message carries a Volverán replay id (Died Again); null otherwise. */
  diedAgain: { replayId: string } | null;
}
