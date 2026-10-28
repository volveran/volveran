// Pure (no I/O): a held Message as one line of a Checkout's NDJSON export,
// and the export's file name. Properties and headers use the lossless AMQP
// JSON of Audit Entries (audit/amqp-json.ts), so a line holds the Message
// exactly as the broker delivered it.
import { toAmqpJson } from '../audit/amqp-json.js';
import { EXPORT_LINE_VERSION, type ExportLine } from '../../shared/export.js';
import type { Decision } from './decisions.js';
import { replayIdOf } from './died-again.js';
import { bodyKind, messageSummary, parseXDeath, type Delivery, type QueueInfo } from './message-view.js';

export type { ExportLine };

/** The line for the held Message at `position` (1 is the head of the queue), with its Decision. */
export function exportLine(position: number, d: Delivery, queue: QueueInfo, decision: Decision): ExportLine {
  const { headers, ...props } = d.properties;
  const properties = Object.fromEntries(Object.entries(props).filter(([, v]) => v !== undefined));
  const summary = messageSummary(position, d, queue);
  const text = (v: unknown) => (typeof v === 'string' ? v : undefined);
  const replayId = replayIdOf(headers);
  return {
    v: EXPORT_LINE_VERSION,
    position,
    messageId: summary.messageId,
    exchange: d.fields.exchange,
    routingKey: d.fields.routingKey,
    // The lossless JSON of a table is an object.
    properties: toAmqpJson(properties) as Record<string, unknown>,
    headers: toAmqpJson(headers ?? {}) as Record<string, unknown>,
    body: d.content.toString('base64'),
    bodyKind: bodyKind(d.content, text(props.contentType), text(props.contentEncoding)),
    xDeath: parseXDeath(headers),
    deliveryBudget: summary.deliveryBudget,
    decision,
    // Died Again (#40): the Message's x-volveran-replay-id, the same test the Checkout uses.
    diedAgain: replayId ? { replayId } : null,
    failureDetails: summary.failureDetails,
  };
}

/**
 * `volveran-<profile>-<queue>-<UTC time>.ndjson`, e.g.
 * `volveran-prod-orders.dlq-20261028T174600Z.ndjson`; characters a file name
 * should not carry become `_`.
 */
export function exportFilename(profile: string, queue: string, at: Date): string {
  const safe = (s: string) => s.replace(/[^A-Za-z0-9._-]/g, '_');
  const time = at.toISOString().replace(/\.\d{3}Z$/, 'Z').replace(/[-:]/g, '');
  return `volveran-${safe(profile)}-${safe(queue)}-${time}.ndjson`;
}
