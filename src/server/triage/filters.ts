// Pure filter evaluation over Messages (no I/O): which held deliveries match
// the filter the Operator set on a Checkout's Message list, so "Select all
// matching" can build a Selection. Every clause must hold (AND).
import { parseXDeath, type Delivery } from './message-view.js';
import { matchesQueueFilter as matchesGlob } from './queue-list.js';
import { parseKind } from './parse-kind.js';
import { replayIdOf } from './died-again.js';
import { failureDetails } from './failure-details.js';
import type { Filter, FilterClause } from '../../shared/filters.js';

export type { Filter, FilterClause };

export type FilterKind = FilterClause['kind'];

const KINDS: readonly FilterKind[] = [
  'routing-key',
  'header',
  'x-death-reason',
  'original-queue',
  'body-text',
  'json-path',
  'died-again',
  'failure',
];

/** The keys each kind of clause takes. An API body may carry others, which are ignored; the profiles file refuses them. */
export const FILTER_CLAUSE_KEYS: Record<FilterKind, readonly string[]> = {
  'routing-key': ['kind', 'value'],
  header: ['kind', 'name', 'value'],
  'x-death-reason': ['kind', 'value'],
  'original-queue': ['kind', 'value'],
  'body-text': ['kind', 'value'],
  'json-path': ['kind', 'path', 'value'],
  'died-again': ['kind'],
  failure: ['kind', 'value'],
};

/** Reads a Filter from untrusted input (an API request body). */
export function parseFilter(input: unknown): { ok: true; filter: Filter } | { ok: false; error: string } {
  if (!Array.isArray(input)) return { ok: false, error: 'A filter is a list of clauses, e.g. [{ "kind": "routing-key", "value": "orders.*" }].' };
  const filter: Filter = [];
  for (const raw of input) {
    const clause = parseClause(raw);
    if (typeof clause === 'string') return { ok: false, error: clause };
    filter.push(clause);
  }
  return { ok: true, filter };
}

/** A clause, or why it isn't one. */
function parseClause(raw: unknown): FilterClause | string {
  const parsed = parseKind(raw, KINDS, 'filter clause');
  if (!parsed.ok) return parsed.error;
  // parseKind only succeeds on an object.
  const c = raw as Record<string, unknown>;
  const { kind } = parsed;
  const optionalValue = (): { value?: string } | string => {
    if (c.value === undefined || c.value === null || c.value === '') return {};
    return typeof c.value === 'string' ? { value: c.value } : `The ${kind} filter's "value" must be text.`;
  };
  switch (kind) {
    case 'header': {
      if (typeof c.name !== 'string' || c.name === '') return 'The header filter needs a header "name".';
      const value = optionalValue();
      return typeof value === 'string' ? value : { kind, name: c.name, ...value };
    }
    case 'json-path': {
      if (typeof c.path !== 'string' || c.path.trim() === '') return 'The json-path filter needs a "path", e.g. "$.order.id".';
      const path = parseJsonPath(c.path.trim());
      if (!path.ok) return path.error;
      const value = optionalValue();
      return typeof value === 'string' ? value : { kind, path: c.path.trim(), ...value };
    }
    case 'died-again':
      return { kind };
    default:
      if (typeof c.value !== 'string' || c.value === '') return `The ${kind} filter needs a "value".`;
      return { kind: kind as 'routing-key' | 'x-death-reason' | 'original-queue' | 'body-text' | 'failure', value: c.value };
  }
}

/** Whether the Message matches every clause of `filter`. */
export function matchesFilter(filter: Filter, message: Delivery): boolean {
  return filter.every((clause) => matchesClause(clause, message));
}

function matchesClause(clause: FilterClause, m: Delivery): boolean {
  switch (clause.kind) {
    case 'routing-key':
      return matchesGlob(m.fields.routingKey, clause.value);
    case 'header': {
      const headers = m.properties.headers ?? {};
      if (!Object.hasOwn(headers, clause.name)) return false;
      if (clause.value === undefined) return true;
      const text = scalarText(headers[clause.name]);
      return text !== null && matchesGlob(text, clause.value);
    }
    case 'x-death-reason':
      return parseXDeath(m.properties.headers).some((e) => e.reason === clause.value);
    case 'original-queue': {
      const queue = parseXDeath(m.properties.headers)[0]?.queue;
      return queue != null && matchesGlob(queue, clause.value);
    }
    case 'body-text': {
      const text = bodyText(m);
      return text !== undefined && text.toLowerCase().includes(clause.value.toLowerCase());
    }
    case 'json-path': {
      const path = parseJsonPath(clause.path);
      if (!path.ok) return false;
      const body = bodyJson(m);
      if (!body.ok) return false;
      const nodes = selectJsonPath(body.value, path.segments);
      if (clause.value === undefined) return nodes.length > 0;
      return nodes.some((node) => jsonScalarText(node) === clause.value);
    }
    case 'failure': {
      const details = failureDetails(m.properties.headers);
      const value = clause.value.toLowerCase();
      return [details?.exceptionType, details?.message].some((t) => t != null && t.toLowerCase().includes(value));
    }
    case 'died-again':
      // The same test that flags the Message in the list (triage/died-again.ts).
      return replayIdOf(m.properties.headers) !== null;
  }
}

function bodyJson(m: Delivery): { ok: true; value: unknown } | { ok: false } {
  const text = bodyText(m);
  if (text === undefined) return { ok: false };
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch {
    return { ok: false };
  }
}

type PathSegment = { kind: 'key'; key: string } | { kind: 'index'; index: number } | { kind: 'wildcard' };

/**
 * Parses a JSON path: an optional leading `$`, then `.key` (the first one may
 * omit the dot), `['key']` or `["key"]`, `[n]` (negative counts from the end)
 * and `[*]` or `.*` (every element or value).
 */
export function parseJsonPath(path: string): { ok: true; segments: PathSegment[] } | { ok: false; error: string } {
  const segments: PathSegment[] = [];
  const fail = (why: string) => ({ ok: false as const, error: `Invalid JSON path "${path}": ${why}.` });
  let i = path.startsWith('$') ? 1 : 0;
  let first = true;
  while (i < path.length) {
    const ch = path[i]!;
    if (ch === '[') {
      const close = path.indexOf(']', i);
      const quote = path[i + 1];
      if (quote === "'" || quote === '"') {
        const end = path.indexOf(quote, i + 2);
        if (end === -1 || path[end + 1] !== ']') return fail(`unclosed quoted key at position ${i}`);
        segments.push({ kind: 'key', key: path.slice(i + 2, end) });
        i = end + 2;
      } else {
        if (close === -1) return fail(`unclosed "[" at position ${i}`);
        const inner = path.slice(i + 1, close).trim();
        if (inner === '*') segments.push({ kind: 'wildcard' });
        else if (/^-?\d+$/.test(inner)) segments.push({ kind: 'index', index: Number(inner) });
        else return fail(`"[${inner}]" is neither an index, * nor a quoted key`);
        i = close + 1;
      }
    } else {
      if (ch === '.') i++;
      else if (!first) return fail(`expected "." or "[" at position ${i}`);
      let end = i;
      while (end < path.length && path[end] !== '.' && path[end] !== '[') end++;
      const key = path.slice(i, end);
      if (key === '') return fail(`empty key at position ${i}`);
      segments.push(key === '*' ? { kind: 'wildcard' } : { kind: 'key', key });
      i = end;
    }
    first = false;
  }
  return { ok: true, segments };
}

/**
 * Every value the path reaches. A key applied to an array reads it from each
 * element, so `items.sku` is the same as `items[*].sku`.
 */
function selectJsonPath(root: unknown, segments: PathSegment[]): unknown[] {
  let nodes: unknown[] = [root];
  for (const seg of segments) {
    nodes = nodes.flatMap((node): unknown[] => {
      if (seg.kind === 'wildcard') {
        if (Array.isArray(node)) return node;
        return isObject(node) ? Object.values(node) : [];
      }
      if (seg.kind === 'index') {
        if (!Array.isArray(node)) return [];
        const index = seg.index < 0 ? node.length + seg.index : seg.index;
        return index >= 0 && index < node.length ? [node[index]] : [];
      }
      const fromObject = (o: unknown) => (isObject(o) && Object.hasOwn(o, seg.key) ? [o[seg.key]] : []);
      return Array.isArray(node) ? node.flatMap(fromObject) : fromObject(node);
    });
  }
  return nodes;
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** The text a JSON scalar is compared by; null for objects and arrays. */
function jsonScalarText(v: unknown): string | null {
  if (typeof v === 'string') return v;
  if (v === null || typeof v === 'number' || typeof v === 'boolean') return String(v);
  return null;
}

/** The body as UTF-8 text; undefined when it is compressed or not valid UTF-8. */
function bodyText(m: Delivery): string | undefined {
  const encoding = m.properties.contentEncoding;
  if (typeof encoding === 'string' && encoding.trim() && !/^(identity|utf-?8)$/i.test(encoding.trim())) return undefined;
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(m.content);
  } catch {
    return undefined;
  }
}

/** The text of a scalar AMQP field value; null for tables, arrays and the like. */
function scalarText(v: unknown): string | null {
  if (typeof v === 'string') return v;
  if (Buffer.isBuffer(v)) return v.toString('utf8');
  if (typeof v === 'number' || typeof v === 'boolean' || typeof v === 'bigint') return String(v);
  return null;
}
