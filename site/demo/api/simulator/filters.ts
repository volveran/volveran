// Which held Messages match a filter ("Select all matching"), and reading a
// filter from a request. Mirrors src/server/triage/filters.ts (which uses
// Node's Buffer): every clause must hold (AND); an empty filter matches all.
import { parseKind } from '../../../../src/server/triage/parse-kind.js';
import type { Filter, FilterClause } from '../../../../src/shared/filters.js';
import type { BrokerMessage } from './broker.js';
import { bodyText, failureDetails, parseXDeath } from './message-view.js';

/** The header a republished Message carries: Volverán sent it out before (src/server/apply/republish.ts). */
export const REPLAY_ID_HEADER = 'x-volveran-replay-id';

type FilterKind = FilterClause['kind'];

const KINDS: readonly FilterKind[] = ['routing-key', 'header', 'x-death-reason', 'original-queue', 'body-text', 'json-path', 'died-again', 'failure'];

/** Reads a Filter from a request body; the error says what is wrong, as the server's does. */
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

function parseClause(raw: unknown): FilterClause | string {
  const parsed = parseKind(raw, KINDS, 'filter clause');
  if (!parsed.ok) return parsed.error;
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
      return typeof value === 'string' ? value : { kind: 'header', name: c.name, ...value };
    }
    case 'json-path': {
      if (typeof c.path !== 'string' || c.path.trim() === '') return 'The json-path filter needs a "path", e.g. "$.order.id".';
      const path = parseJsonPath(c.path.trim());
      if (!path.ok) return path.error;
      const value = optionalValue();
      return typeof value === 'string' ? value : { kind: 'json-path', path: c.path.trim(), ...value };
    }
    case 'died-again':
      return { kind: 'died-again' };
    default:
      if (typeof c.value !== 'string' || c.value === '') return `The ${kind} filter needs a "value".`;
      return { kind: kind as 'routing-key' | 'x-death-reason' | 'original-queue' | 'body-text' | 'failure', value: c.value };
  }
}

export function matchesFilter(filter: Filter, m: BrokerMessage): boolean {
  return filter.every((clause) => matchesClause(clause, m));
}

function matchesClause(clause: FilterClause, m: BrokerMessage): boolean {
  const headers = m.properties.headers ?? {};
  switch (clause.kind) {
    case 'routing-key':
      return matchesGlob(m.routingKey, clause.value);
    case 'header': {
      if (!Object.hasOwn(headers, clause.name)) return false;
      if (clause.value === undefined) return true;
      const text = scalarText(headers[clause.name]);
      return text !== null && matchesGlob(text, clause.value);
    }
    case 'x-death-reason':
      return parseXDeath(headers).some((e) => e.reason === clause.value);
    case 'original-queue': {
      const queue = parseXDeath(headers)[0]?.queue;
      return queue != null && matchesGlob(queue, clause.value);
    }
    case 'body-text': {
      const text = bodyText(m.content);
      return text !== undefined && text.toLowerCase().includes(clause.value.toLowerCase());
    }
    case 'json-path': {
      const path = parseJsonPath(clause.path);
      const text = bodyText(m.content);
      if (!path.ok || text === undefined) return false;
      let value: unknown;
      try {
        value = JSON.parse(text);
      } catch {
        return false;
      }
      const nodes = selectJsonPath(value, path.segments);
      if (clause.value === undefined) return nodes.length > 0;
      return nodes.some((node) => jsonScalarText(node) === clause.value);
    }
    case 'failure': {
      const details = failureDetails(headers);
      const value = clause.value.toLowerCase();
      return [details?.exceptionType, details?.message].some((t) => t != null && t.toLowerCase().includes(value));
    }
    case 'died-again':
      return typeof headers[REPLAY_ID_HEADER] === 'string' && headers[REPLAY_ID_HEADER] !== '';
  }
}

/** `*` and `?` wildcards, as the queue filter (src/server/triage/queue-list.ts). */
function matchesGlob(name: string, pattern: string): boolean {
  const source = pattern
    .split('')
    .map((ch) => (ch === '*' ? '.*' : ch === '?' ? '.' : ch.replace(/[.+^${}()|[\]\\]/g, '\\$&')))
    .join('');
  return new RegExp(`^${source}$`).test(name);
}

type PathSegment = { kind: 'key'; key: string } | { kind: 'index'; index: number } | { kind: 'wildcard' };

function parseJsonPath(path: string): { ok: true; segments: PathSegment[] } | { ok: false; error: string } {
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

function selectJsonPath(root: unknown, segments: PathSegment[]): unknown[] {
  let nodes: unknown[] = [root];
  for (const seg of segments) {
    nodes = nodes.flatMap((node): unknown[] => {
      if (seg.kind === 'wildcard') return Array.isArray(node) ? node : isObject(node) ? Object.values(node) : [];
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

function jsonScalarText(v: unknown): string | null {
  if (typeof v === 'string') return v;
  if (v === null || typeof v === 'number' || typeof v === 'boolean') return String(v);
  return null;
}

function scalarText(v: unknown): string | null {
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  return null;
}
