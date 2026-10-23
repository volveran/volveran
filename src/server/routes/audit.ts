// Audit Entry routes (read only; #10 adds browsing filters and Restore).
//
//   GET /api/audit-entries?queue=&messageId=&action=&checkoutId=&replayId=&from=&to=&limit=
//       → { entries: AuditEntryJson[] }, newest first, without Message bodies
//   GET /api/audit-entries/:id → { entry: AuditEntryJson } with the body (base64)
//
// Properties and headers use the lossless AMQP JSON of audit/amqp-json.ts
// (byte arrays as { "$bytes": base64 }, 64-bit integers as { "$bigint": "..." }).
import type { FastifyInstance } from 'fastify';
import { toAmqpJson } from '../audit/amqp-json.js';
import type { AuditAction, AuditEntry, AuditQuery, AuditStore } from '../audit/store.js';
import { HttpError, InvalidRequestError } from '../http-error.js';

/** An Audit Entry as JSON; `body` (base64) only when given. */
export function auditEntryJson(entry: AuditEntry, body?: Buffer | null) {
  const { message, at, ...rest } = entry;
  return {
    ...rest,
    at: at.toISOString(),
    message: message && {
      properties: toAmqpJson(message.properties),
      headers: toAmqpJson(message.headers),
      bodyBytes: message.bodyBytes,
      ...(body !== undefined && { body: body ? body.toString('base64') : null }),
    },
  };
}

export interface AuditSearchParams {
  queue?: string;
  messageId?: string;
  action?: string;
  checkoutId?: string;
  /** The x-volveran-replay-id of a Replayed or Moved Message. */
  replayId?: string;
  /** ISO 8601 date or date-time; entries at or after it. */
  from?: string;
  /** ISO 8601 date or date-time; entries at or before it (a bare date includes that whole day). */
  to?: string;
  limit?: string;
}

const ACTIONS: AuditAction[] = ['discard', 'replay', 'move', 'restore'];
const DEFAULT_LIMIT = 500;

/** Turns the query string of GET /api/audit-entries into an AuditQuery; empty values are ignored. */
export function parseAuditSearch(params: AuditSearchParams): AuditQuery {
  const query: AuditQuery = { limit: DEFAULT_LIMIT };
  const given = (v: string | undefined) => (v === undefined || v.trim() === '' ? undefined : v.trim());
  if (given(params.queue)) query.queue = given(params.queue);
  if (given(params.messageId)) query.messageId = given(params.messageId);
  if (given(params.checkoutId)) query.checkoutId = given(params.checkoutId);
  if (given(params.replayId)) query.replayId = given(params.replayId);
  const action = given(params.action);
  if (action) {
    if (!ACTIONS.includes(action as AuditAction)) {
      throw new InvalidRequestError(`"action" must be one of ${ACTIONS.join(', ')}.`);
    }
    query.action = action as AuditAction;
  }
  const from = given(params.from);
  if (from) query.from = parseDate('from', from);
  const to = given(params.to);
  if (to) {
    const date = parseDate('to', to);
    // A bare date means up to the end of that day.
    query.to = /^\d{4}-\d{2}-\d{2}$/.test(to) ? new Date(date.getTime() + 24 * 60 * 60 * 1000 - 1) : date;
  }
  const limit = given(params.limit);
  if (limit) {
    const n = Number(limit);
    if (!Number.isSafeInteger(n) || n < 1) throw new InvalidRequestError('"limit" must be a positive integer.');
    query.limit = n;
  }
  return query;
}

function parseDate(name: string, value: string): Date {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new InvalidRequestError(`"${name}" must be an ISO 8601 date or date-time, not "${value}".`);
  }
  return date;
}

export function registerAuditRoutes(app: FastifyInstance, audit: AuditStore) {
  app.get<{ Querystring: AuditSearchParams }>('/api/audit-entries', async (req) => ({
    entries: audit.list(parseAuditSearch(req.query)).map((e) => auditEntryJson(e)),
  }));

  app.get<{ Params: { id: string } }>('/api/audit-entries/:id', async (req) => {
    const id = Number(req.params.id);
    const entry = Number.isSafeInteger(id) ? audit.get(id) : null;
    if (!entry) throw new HttpError(404, 'audit_entry_not_found', `No Audit Entry ${req.params.id}.`);
    return { entry: auditEntryJson(entry, audit.body(id)) };
  });
}
