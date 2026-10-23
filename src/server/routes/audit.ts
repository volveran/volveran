// Audit Entry routes: browsing, Restore and the body store's size.
//
//   GET /api/audit-entries?profile=&queue=&messageId=&action=&operator=&checkoutId=&from=&to=&limit=
//       → { entries: AuditEntryJson[] }, newest first, without Message bodies
//   GET /api/audit-entries/:id → { entry: AuditEntryJson } with the body (base64; null once expired)
//   POST /api/audit-entries/:id/restore { confirm, queue?, confirmUncertain?, confirmQueueName? }
//       → { entry: AuditEntryJson } the Restore's own Audit Entry (outcome done or failed)
//   GET /api/audit-store → BodyStoreUsage (stored body bytes vs the size limit, for the UI warning)
//
// Anyone who may use Volverán may browse and Restore (no roles in v0.1); the
// Restore is recorded as the requesting Operator's.
//
// Properties and headers use the lossless AMQP JSON of audit/amqp-json.ts
// (byte arrays as { "$bytes": base64 }, 64-bit integers as { "$bigint": "..." }).
import type { FastifyInstance } from 'fastify';
import { toAmqpJson } from '../audit/amqp-json.js';
import type { BodyStoreUsage } from '../audit/body-retention.js';
import type { RestoreRequest, RestoreService } from '../audit/restore.js';
import type { AuditAction, AuditEntry, AuditQuery, AuditStore } from '../audit/store.js';
import { HttpError, InvalidRequestError } from '../http-error.js';
import { operatorOf } from '../operator.js';

/** An Audit Entry as JSON; `body` (base64) only when given. */
export function auditEntryJson(entry: AuditEntry, body?: Buffer | null) {
  const { message, at, bodyExpiredAt, ...rest } = entry;
  return {
    ...rest,
    at: at.toISOString(),
    bodyExpiredAt: bodyExpiredAt?.toISOString() ?? null,
    message: message && {
      properties: toAmqpJson(message.properties),
      headers: toAmqpJson(message.headers),
      bodyBytes: message.bodyBytes,
      ...(body !== undefined && { body: body ? body.toString('base64') : null }),
    },
  };
}

export interface AuditSearchParams {
  profile?: string;
  queue?: string;
  /** The Operator's id or display name. */
  operator?: string;
  messageId?: string;
  action?: string;
  checkoutId?: string;
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
  if (given(params.profile)) query.profile = given(params.profile);
  if (given(params.queue)) query.queue = given(params.queue);
  if (given(params.operator)) query.operator = given(params.operator);
  if (given(params.messageId)) query.messageId = given(params.messageId);
  if (given(params.checkoutId)) query.checkoutId = given(params.checkoutId);
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

export interface AuditRouteDeps {
  audit: AuditStore;
  restore: RestoreService;
  usage: () => BodyStoreUsage;
}

export function registerAuditRoutes(app: FastifyInstance, { audit, restore, usage }: AuditRouteDeps) {
  app.get<{ Querystring: AuditSearchParams }>('/api/audit-entries', async (req) => ({
    entries: audit.list(parseAuditSearch(req.query)).map((e) => auditEntryJson(e)),
  }));

  app.get<{ Params: { id: string } }>('/api/audit-entries/:id', async (req) => {
    const id = Number(req.params.id);
    const entry = Number.isSafeInteger(id) ? audit.get(id) : null;
    if (!entry) throw new HttpError(404, 'audit_entry_not_found', `No Audit Entry ${req.params.id}.`);
    return { entry: auditEntryJson(entry, audit.body(id)) };
  });

  app.post<{ Params: { id: string }; Body: RestoreRequest | undefined }>('/api/audit-entries/:id/restore', async (req) => {
    const operator = operatorOf(req);
    const id = Number(req.params.id);
    if (!Number.isSafeInteger(id)) throw new HttpError(404, 'audit_entry_not_found', `No Audit Entry ${req.params.id}.`);
    return { entry: auditEntryJson(await restore.restore(id, req.body ?? undefined, operator)) };
  });

  app.get('/api/audit-store', async () => usage());
}
