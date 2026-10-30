// Audit Entry routes: browsing, Restore and the body store's size.
//
//   GET /api/audit-entries?profile=&queue=&messageId=&action=&operator=&checkoutId=&replayId=&rule=&from=&to=&limit=
//       → { entries: AuditEntryJson[] }, newest first, without Message bodies
//   GET /api/audit-entries/:id → { entry: AuditEntryJson } with the body (base64; null once expired)
//   POST /api/audit-entries/:id/restore { confirm, queue?, confirmUncertain?, confirmQueueName? }
//       → { entry: AuditEntryJson } the Restore's own Audit Entry (outcome done or failed)
//   GET /api/audit-store → BodyStoreUsage (stored body bytes vs the size limit, for the UI warning)
//
// Each route resolves the entry's Broker Profile through the access check
// (profile-access.ts): search returns only the entries the Operator may read, a
// body comes only with `read_discarded_bodies`, Restore needs `restore`. On
// an entry of a profile no longer configured the Operator holds the highest
// Role they hold anywhere. The body store's size needs a Role on some
// profile (403 `no_role`). The Restore is recorded as the requesting
// Operator's.
//
// Properties and headers use the lossless AMQP JSON of audit/amqp-json.ts
// (byte arrays as { "$bytes": base64 }, 64-bit integers as { "$bigint": "..." }).
import type { FastifyInstance } from 'fastify';
import { toAmqpJson } from '../audit/amqp-json.js';
import type { BodyStoreUsage } from '../audit/body-retention.js';
import type { RestoreRequest, RestoreService } from '../audit/restore.js';
import type { AuditEntry, AuditQuery, AuditStore } from '../audit/audit-store.js';
import { AUDIT_ACTIONS, type AuditAction, type AuditEntryJson } from '../../shared/audit.js';
import { HttpError, InvalidRequestError } from '../http-error.js';
import { operatorOf } from '../operator.js';
import type { ProfileAccessCheck } from '../profile-access.js';

/** An Audit Entry as JSON; `body` (base64) only when given. */
export function auditEntryJson(entry: AuditEntry, body?: Buffer | null): AuditEntryJson {
  const { message, at, bodyExpiredAt, ...rest } = entry;
  return {
    ...rest,
    at: at.toISOString(),
    bodyExpiredAt: bodyExpiredAt?.toISOString() ?? null,
    message: message && {
      // The lossless JSON of a table is an object.
      properties: toAmqpJson(message.properties) as Record<string, unknown>,
      headers: toAmqpJson(message.headers) as Record<string, unknown>,
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
  /** The x-volveran-replay-id of a Replayed or Moved Message. */
  replayId?: string;
  /** The name of the Replay Rule whose passes wrote the entries. */
  rule?: string;
  /** ISO 8601 date or date-time; entries at or after it. */
  from?: string;
  /** ISO 8601 date or date-time; entries at or before it (a bare date includes that whole day). */
  to?: string;
  limit?: string;
}

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
  if (given(params.replayId)) query.replayId = given(params.replayId);
  if (given(params.rule)) query.rule = given(params.rule);
  const action = given(params.action);
  if (action) {
    if (!(AUDIT_ACTIONS as readonly string[]).includes(action)) {
      throw new InvalidRequestError(`"action" must be one of ${AUDIT_ACTIONS.join(', ')}.`);
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
  usage: () => Promise<BodyStoreUsage>;
}

export function registerAuditRoutes(
  app: FastifyInstance,
  { audit, restore, usage }: AuditRouteDeps,
  access: ProfileAccessCheck,
) {
  const entryOf = async (param: string): Promise<AuditEntry> => {
    const id = Number(param);
    const entry = Number.isSafeInteger(id) ? await audit.get(id) : null;
    if (!entry) throw new HttpError(404, 'audit_entry_not_found', `No Audit Entry ${param}.`);
    return entry;
  };

  app.get<{ Querystring: AuditSearchParams }>('/api/audit-entries', async (req) => {
    const operator = operatorOf(req);
    // Left out in the query, so `limit` counts only the entries the Operator may read.
    const entries = await audit.list({ ...parseAuditSearch(req.query), profiles: access.auditScope(operator, 'read_audit_entries') });
    return { entries: entries.map((e) => auditEntryJson(e)) };
  });

  app.get<{ Params: { id: string } }>('/api/audit-entries/:id', async (req) => {
    const operator = operatorOf(req);
    const entry = await entryOf(req.params.id);
    access.ofAuditEntry(operator, 'read_audit_entries', entry);
    const body = access.holds(operator, 'read_discarded_bodies', entry.profile) ? await audit.body(entry.id) : undefined;
    return { entry: auditEntryJson(entry, body) };
  });

  app.post<{ Params: { id: string }; Body: RestoreRequest | undefined }>('/api/audit-entries/:id/restore', async (req) => {
    const operator = operatorOf(req);
    const entry = await entryOf(req.params.id);
    const target = access.ofAuditEntry(operator, 'restore', entry);
    return { entry: auditEntryJson(await restore.restore(entry.id, req.body ?? undefined, operator, target)) };
  });

  app.get('/api/audit-store', async (req) => {
    access.assertSomeRole(operatorOf(req));
    return usage();
  });
}
