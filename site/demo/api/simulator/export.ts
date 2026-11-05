// A Checkout's NDJSON export, generated in the browser: one line per held
// Message in queue order, in the format of src/server/triage/export-line.ts
// (documented in docs/exporting.md), which uses Node's Buffer and so does not
// run here. test/unit/demo-restore.test.ts checks each line against the
// server's for the same Message.
import type { Decision } from '../../../../src/shared/decisions.js';
import { EXPORT_LINE_VERSION, type ExportLine } from '../../../../src/shared/export.js';
import type { BrokerMessage } from './broker.js';
import { REPLAY_ID_HEADER } from './filters.js';
import { messageSummary, parseXDeath, renderBody, toBase64, type QueueInfo } from './message-view.js';

/** The line for the held Message at `position` (1 is the head of the queue), with its Decision. */
export function exportLine(position: number, m: BrokerMessage, queue: QueueInfo, decision: Decision): ExportLine {
  const { headers, ...props } = m.properties;
  const properties = Object.fromEntries(Object.entries(props).filter(([, v]) => v !== undefined));
  const summary = messageSummary(position, m, queue);
  const replayId = headers?.[REPLAY_ID_HEADER];
  return {
    v: EXPORT_LINE_VERSION,
    position,
    messageId: summary.messageId,
    exchange: m.exchange,
    routingKey: m.routingKey,
    properties: amqpJson(properties) as Record<string, unknown>,
    headers: amqpJson(headers ?? {}) as Record<string, unknown>,
    body: toBase64(m.content),
    bodyKind: renderBody(m.content, props.contentType, props.contentEncoding).kind,
    xDeath: parseXDeath(headers),
    deliveryBudget: summary.deliveryBudget,
    decision,
    diedAgain: typeof replayId === 'string' && replayId !== '' ? { replayId } : null,
    failureDetails: summary.failureDetails,
  };
}

/**
 * `volveran-<profile>-<queue>-<UTC time>.ndjson`, as the server names it
 * (export-line.ts, exportFilename); characters a file name should not carry become `_`.
 */
export function exportFilename(profile: string, queue: string, at: Date): string {
  const safe = (s: string) => s.replace(/[^A-Za-z0-9._-]/g, '_');
  const time = at.toISOString().replace(/\.\d{3}Z$/, 'Z').replace(/[-:]/g, '');
  return `volveran-${safe(profile)}-${safe(queue)}-${time}.ndjson`;
}

/** The lossless AMQP JSON of src/server/audit/amqp-json.ts (toAmqpJson), with byte arrays as Uint8Array. */
function amqpJson(value: unknown): unknown {
  if (value instanceof Uint8Array) return { $bytes: toBase64(value) };
  if (typeof value === 'bigint') return { $bigint: value.toString() };
  if (Array.isArray(value)) return value.map(amqpJson);
  if (typeof value === 'object' && value !== null) {
    const entries = Object.entries(value).filter(([, v]) => v !== undefined);
    const table = Object.fromEntries(entries.map(([k, v]) => [k, amqpJson(v)]));
    return entries.some(([k]) => k.startsWith('$')) ? { $table: table } : table;
  }
  return value;
}
