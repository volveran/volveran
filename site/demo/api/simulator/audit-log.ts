// The demo's audit store: Audit Entries in memory, numbered from 1, with the
// body of every Discard kept for Restore. Entries are written `pending`
// before the broker is touched and then given their outcome, as the server
// does (ADR 0001). Search mirrors GET /api/audit-entries (routes/audit.ts and
// audit/audit-entry-sql.ts): newest first, without bodies.
import { AUDIT_ACTIONS, type AuditAction, type AuditCanaryOutcome, type AuditEntryJson, type AuditOutcome } from '../../../../src/shared/audit.js';
import { DemoApiError } from '../router.js';
import { toBase64 } from './message-view.js';

/** What a new entry records; the log adds its id and the `pending` outcome. */
export type NewAuditEntry = Omit<AuditEntryJson, 'id' | 'outcome' | 'outcomeReason' | 'canaryOutcome' | 'bodyExpiredAt' | 'message'> & {
  message: { properties: Record<string, unknown>; headers: Record<string, unknown>; body: Uint8Array | null } | null;
};

interface Stored {
  entry: AuditEntryJson;
  body: Uint8Array | null;
}

export interface AuditSearch {
  profile?: string;
  queue?: string;
  operator?: string;
  messageId?: string;
  action?: AuditAction;
  checkoutId?: string;
  replayId?: string;
  rule?: string;
  from?: Date;
  to?: Date;
  limit: number;
}

const DEFAULT_LIMIT = 500;

export class AuditLog {
  readonly #entries: Stored[] = [];

  /** Writes an entry `pending`; returns its id. */
  record(entry: NewAuditEntry): number {
    const id = this.#entries.length + 1;
    const { message, ...rest } = entry;
    this.#entries.push({
      entry: {
        ...rest,
        id,
        outcome: 'pending',
        outcomeReason: null,
        canaryOutcome: null,
        bodyExpiredAt: null,
        message: message && { properties: message.properties, headers: message.headers, bodyBytes: message.body?.length ?? null },
      },
      body: message?.body ?? null,
    });
    return id;
  }

  setOutcome(id: number, outcome: Exclude<AuditOutcome, 'pending'>, reason: string | null = null): void {
    const stored = this.#stored(id);
    stored.entry = { ...stored.entry, outcome, outcomeReason: reason };
  }

  /** How the watch of a Canary ended. */
  setCanaryOutcome(id: number, canaryOutcome: AuditCanaryOutcome): void {
    const stored = this.#stored(id);
    stored.entry = { ...stored.entry, canaryOutcome };
  }

  /** One entry with its body (base64; null when none was kept); null for an id it does not have. */
  get(id: number): AuditEntryJson | null {
    const stored = this.#entries[id - 1];
    if (!stored) return null;
    const { entry, body } = stored;
    return { ...entry, message: entry.message && { ...entry.message, body: body ? toBase64(body) : null } };
  }

  /** The stored body of an entry, for a Restore (#151). */
  body(id: number): Uint8Array | null {
    return this.#entries[id - 1]?.body ?? null;
  }

  /** How many bytes of Discarded bodies the store keeps, for the audit store usage. */
  storedBodyBytes(): number {
    return this.#entries.reduce((sum, s) => sum + (s.body?.length ?? 0), 0);
  }

  /** The entry that published `replayId` (Replay, Move or Restore): the Died Again trail (#150). */
  byReplayId(replayId: string): AuditEntryJson | null {
    return this.#entries.find((s) => s.entry.replayId === replayId)?.entry ?? null;
  }

  /** The Restores of the Discard of entry `id`, oldest first. */
  restoresOf(id: number): AuditEntryJson[] {
    return this.#entries.filter((s) => s.entry.restoreOf === id).map((s) => s.entry);
  }

  /** Every entry matching `query`, newest first, without bodies. */
  list(query: AuditSearch): AuditEntryJson[] {
    const e = (s: Stored) => s.entry;
    const at = (s: Stored) => new Date(s.entry.at).getTime();
    return this.#entries
      .filter((s) => query.profile === undefined || e(s).profile === query.profile)
      .filter((s) => query.queue === undefined || e(s).queue === query.queue || e(s).destination?.queue === query.queue)
      .filter((s) => query.operator === undefined || e(s).operatorId === query.operator || e(s).operatorName === query.operator)
      .filter((s) => query.messageId === undefined || e(s).messageId === query.messageId)
      .filter((s) => query.action === undefined || e(s).action === query.action)
      .filter((s) => query.checkoutId === undefined || e(s).checkoutId === query.checkoutId)
      .filter((s) => query.replayId === undefined || e(s).replayId === query.replayId)
      .filter((s) => query.rule === undefined || e(s).rule === query.rule)
      .filter((s) => query.from === undefined || at(s) >= query.from.getTime())
      .filter((s) => query.to === undefined || at(s) <= query.to.getTime())
      .reverse()
      .slice(0, query.limit)
      .map(e);
  }

  #stored(id: number): Stored {
    const stored = this.#entries[id - 1];
    if (!stored) throw new Error(`No Audit Entry ${id}.`);
    return stored;
  }
}

/** The query string of GET /audit-entries as a search; 400 `invalid_request` as the server answers it. */
export function parseAuditSearch(params: URLSearchParams): AuditSearch {
  const query: AuditSearch = { limit: DEFAULT_LIMIT };
  const given = (name: string) => {
    const v = params.get(name);
    return v === null || v.trim() === '' ? undefined : v.trim();
  };
  for (const name of ['profile', 'queue', 'operator', 'messageId', 'checkoutId', 'replayId', 'rule'] as const) {
    const v = given(name);
    if (v !== undefined) query[name] = v;
  }
  const action = given('action');
  if (action) {
    if (!(AUDIT_ACTIONS as readonly string[]).includes(action)) throw invalid(`"action" must be one of ${AUDIT_ACTIONS.join(', ')}.`);
    query.action = action as AuditAction;
  }
  const from = given('from');
  if (from) query.from = parseDate('from', from);
  const to = given('to');
  if (to) {
    const date = parseDate('to', to);
    query.to = /^\d{4}-\d{2}-\d{2}$/.test(to) ? new Date(date.getTime() + 24 * 60 * 60 * 1000 - 1) : date;
  }
  const limit = given('limit');
  if (limit) {
    const n = Number(limit);
    if (!Number.isSafeInteger(n) || n < 1) throw invalid('"limit" must be a positive integer.');
    query.limit = n;
  }
  return query;
}

function parseDate(name: string, value: string): Date {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw invalid(`"${name}" must be an ISO 8601 date or date-time, not "${value}".`);
  return date;
}

export function invalid(message: string): DemoApiError {
  return new DemoApiError(400, 'invalid_request', message);
}
