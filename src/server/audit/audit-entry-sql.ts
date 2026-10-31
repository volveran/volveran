// What both stores share about Audit Entries: the statements that find and write
// them, and how a row reads back. The stores differ in how a statement names its
// parameters (`placeholder`, given each parameter's position from 1) and in how
// they run it.
import { fromAmqpJson, toAmqpJson } from './amqp-json.js';
import type { AuditEntry, AuditQuery, NewAuditEntry } from './audit-store.js';
import type { AuditAction, AuditCanaryOutcome, AuditOutcome } from '../../shared/audit.js';
import type { Filter } from '../../shared/filters.js';
import type { Role } from '../../shared/roles.js';

export type Placeholder = (position: number) => string;
export type SqlValue = string | number | null;

export const positions = (placeholder: Placeholder) => {
  let position = 0;
  return () => placeholder(++position);
};

/** The statement that writes a `pending` entry, and its values. It answers nothing about the new row; a store adds what it needs to learn its id. */
export function insertEntry(entry: NewAuditEntry, placeholder: Placeholder): { sql: string; values: SqlValue[] } {
  const { message, destination } = entry;
  const columns: Array<[string, SqlValue]> = [
    ['created_at', entry.at.getTime()],
    ['operator_id', entry.operator.id],
    ['operator_name', entry.operator.displayName],
    ['broker_user', entry.brokerUser],
    ['profile', entry.profile],
    ['vhost', entry.vhost],
    ['queue', entry.queue],
    ['message_id', entry.messageId],
    ['action', entry.action],
    ['reason', entry.reason],
    ['destination_exchange', destination?.exchange ?? null],
    ['destination_routing_key', destination?.routingKey ?? null],
    ['destination_queue', destination?.queue ?? null],
    ['outcome', 'pending'],
    ['checkout_id', entry.checkoutId],
    ['message_properties', message ? JSON.stringify(toAmqpJson(message.properties)) : null],
    ['message_headers', message ? JSON.stringify(toAmqpJson(message.headers)) : null],
    ['body_bytes', message?.body ? message.body.length : null],
    ['replay_id', entry.replayId ?? null],
    ['restore_of', entry.restoreOf ?? null],
    ['operator_role', entry.role ?? null],
    ['approver_id', entry.approver?.id ?? null],
    ['approver_name', entry.approver?.displayName ?? null],
    ['filter', entry.filter ? JSON.stringify(entry.filter) : null],
    ['message_count', entry.messageCount ?? null],
    ['rate', entry.rate ?? null],
    ['rule', entry.rule ?? null],
    ['rule_pass_id', entry.rulePassId ?? null],
    ['canary', entry.canary ? 1 : 0],
  ];
  const next = positions(placeholder);
  return {
    sql: `INSERT INTO audit_entries (${columns.map(([name]) => name).join(', ')}) VALUES (${columns.map(() => next()).join(', ')})`,
    values: columns.map(([, value]) => value),
  };
}

/** The statement that finds the entries matching `query`, newest first, and its values. */
export function searchEntries(query: AuditQuery, placeholder: Placeholder): { sql: string; values: SqlValue[] } {
  const next = positions(placeholder);
  const where: string[] = [];
  const values: SqlValue[] = [];
  /** `condition` gets the next parameters, one for each `value`. */
  const match = (condition: (...params: string[]) => string, ...given: SqlValue[]) => {
    where.push(condition(...given.map(() => next())));
    values.push(...given);
  };
  const equal = (column: string, value: SqlValue) => match((p) => `${column} = ${p}`, value);
  if (query.queue !== undefined) match((a, b) => `(queue = ${a} OR destination_queue = ${b})`, query.queue, query.queue);
  if (query.messageId !== undefined) equal('message_id', query.messageId);
  if (query.action !== undefined) equal('action', query.action);
  if (query.checkoutId !== undefined) equal('checkout_id', query.checkoutId);
  if (query.replayId !== undefined) equal('replay_id', query.replayId);
  if (query.profile !== undefined) equal('profile', query.profile);
  const scope = query.profiles;
  if (scope && 'only' in scope) {
    match((...params) => (params.length ? `profile IN (${params.join(', ')})` : '1 = 0'), ...scope.only);
  } else if (scope?.except.length) {
    match((...params) => `profile NOT IN (${params.join(', ')})`, ...scope.except);
  }
  if (query.operator !== undefined) match((a, b) => `(operator_id = ${a} OR operator_name = ${b})`, query.operator, query.operator);
  if (query.restoreOf !== undefined) equal('restore_of', query.restoreOf);
  if (query.rule !== undefined) equal('rule', query.rule);
  if (query.from !== undefined) match((p) => `created_at >= ${p}`, query.from.getTime());
  if (query.to !== undefined) match((p) => `created_at <= ${p}`, query.to.getTime());
  let sql = 'SELECT * FROM audit_entries';
  if (where.length) sql += ` WHERE ${where.join(' AND ')}`;
  sql += ' ORDER BY created_at DESC, id DESC';
  if (query.limit !== undefined) {
    sql += ` LIMIT ${next()}`;
    values.push(query.limit);
  }
  return { sql, values };
}

export interface EntryRow {
  id: number;
  created_at: number;
  operator_id: string;
  operator_name: string;
  broker_user: string;
  profile: string;
  vhost: string;
  queue: string;
  message_id: string | null;
  action: AuditAction;
  reason: string | null;
  destination_exchange: string | null;
  destination_routing_key: string | null;
  destination_queue: string | null;
  outcome: AuditOutcome;
  outcome_reason: string | null;
  checkout_id: string | null;
  message_properties: string | null;
  message_headers: string | null;
  body_bytes: number | null;
  replay_id: string | null;
  restore_of: number | null;
  body_expired_at: number | null;
  operator_role: Role | null;
  approver_id: string | null;
  approver_name: string | null;
  filter: string | null;
  message_count: number | null;
  rate: number | null;
  rule: string | null;
  rule_pass_id: string | null;
  canary: number;
  canary_outcome: AuditCanaryOutcome | null;
}

export function toEntry(row: EntryRow): AuditEntry {
  return {
    id: row.id,
    at: new Date(row.created_at),
    operatorId: row.operator_id,
    operatorName: row.operator_name,
    role: row.operator_role,
    approverId: row.approver_id,
    approverName: row.approver_name,
    brokerUser: row.broker_user,
    profile: row.profile,
    vhost: row.vhost,
    queue: row.queue,
    messageId: row.message_id,
    action: row.action,
    reason: row.reason,
    destination:
      row.destination_routing_key === null
        ? null
        : {
            exchange: row.destination_exchange ?? '',
            routingKey: row.destination_routing_key,
            queue: row.destination_queue,
          },
    outcome: row.outcome,
    outcomeReason: row.outcome_reason,
    checkoutId: row.checkout_id,
    replayId: row.replay_id,
    restoreOf: row.restore_of,
    bodyExpiredAt: row.body_expired_at === null ? null : new Date(row.body_expired_at),
    filter: row.filter === null ? null : (JSON.parse(row.filter) as Filter),
    messageCount: row.message_count,
    rate: row.rate,
    rule: row.rule,
    rulePassId: row.rule_pass_id,
    canary: row.canary === 1,
    canaryOutcome: row.canary_outcome,
    message:
      row.message_properties === null
        ? null
        : {
            properties: fromAmqpJson(JSON.parse(row.message_properties)) as Record<string, unknown>,
            headers: fromAmqpJson(JSON.parse(row.message_headers ?? '{}')) as Record<string, unknown>,
            bodyBytes: row.body_bytes,
          },
  };
}
