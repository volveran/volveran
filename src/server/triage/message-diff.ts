// Pure Message diff (no I/O): compares two Message views for the comparison
// view. Properties and headers line up by name, x-death entries by position,
// Failure Details by field, and the body by kind.
import { isRecord } from '../is-record.js';
import type { MessageDetail, RenderedBody, XDeathEntry } from '../../shared/checkout.js';
import type {
  BodyDiff,
  FieldDiff,
  FieldStatus,
  JsonChange,
  MessageDiff,
  TextHunk,
  XDeathDiff,
} from '../../shared/message-diff.js';

export type { MessageDiff };

/** The parts of a Message view the diff reads. `failureDetails` is null or absent when there are none. */
export type ComparableMessage = Pick<MessageDetail, 'properties' | 'headers' | 'xDeath' | 'body'> & {
  failureDetails?: object | null;
};

export function diffMessages(left: ComparableMessage, right: ComparableMessage): MessageDiff {
  return {
    properties: diffFields(left.properties, right.properties),
    headers: diffFields(withoutXDeath(left.headers), withoutXDeath(right.headers)),
    xDeath: diffXDeath(left.xDeath, right.xDeath),
    failureDetails:
      left.failureDetails || right.failureDetails ? diffFields({ ...left.failureDetails }, { ...right.failureDetails }) : null,
    body: diffBodies(left.body, right.body),
  };
}

function diffBodies(left: RenderedBody, right: RenderedBody): BodyDiff {
  if (left.kind === 'json' && right.kind === 'json') {
    const changes: JsonChange[] = [];
    diffJson(JSON.parse(left.text), JSON.parse(right.text), '$', changes);
    return { kind: 'json', equal: changes.length === 0, changes };
  }
  if (left.kind === 'text' && right.kind === 'text') {
    const hunks = diffLines(left.text.split('\n'), right.text.split('\n'));
    return { kind: 'text', equal: hunks.length === 0, hunks };
  }
  if (left.kind === 'binary' && right.kind === 'binary') {
    const a = Buffer.from(left.hex, 'hex');
    const b = Buffer.from(right.hex, 'hex');
    let first = 0;
    while (first < a.length && first < b.length && a[first] === b[first]) first++;
    const equal = a.length === b.length && first === a.length;
    return { kind: 'binary', equal, leftSize: left.size, rightSize: right.size, firstDifferentByte: equal ? null : first };
  }
  return { kind: 'mixed', equal: false, leftKind: left.kind, rightKind: right.kind };
}

/** Above this many line pairs, the lines between the common start and end form one hunk instead of a full diff. */
const MAX_LINE_PAIRS = 4_000_000;

/**
 * Line hunks from a longest-common-subsequence diff of the lines between the
 * common first and last lines. A hunk's start is the 1-based number of its
 * first line on each side (or of the line it comes before, when it has none there).
 */
function diffLines(left: string[], right: string[]): TextHunk[] {
  let start = 0;
  while (start < left.length && start < right.length && left[start] === right[start]) start++;
  let endL = left.length;
  let endR = right.length;
  while (endL > start && endR > start && left[endL - 1] === right[endR - 1]) {
    endL--;
    endR--;
  }
  const n = endL - start;
  const m = endR - start;
  if (n === 0 && m === 0) return [];
  if (n * m > MAX_LINE_PAIRS) {
    return [{ leftStart: start + 1, leftLines: left.slice(start, endL), rightStart: start + 1, rightLines: right.slice(start, endR) }];
  }

  // lcs[i * (m + 1) + j]: the longest common subsequence of the middle lines from i and j on.
  const lcs = new Uint32Array((n + 1) * (m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i * (m + 1) + j] =
        left[start + i] === right[start + j]
          ? lcs[(i + 1) * (m + 1) + j + 1]! + 1
          : Math.max(lcs[(i + 1) * (m + 1) + j]!, lcs[i * (m + 1) + j + 1]!);
    }
  }

  const hunks: TextHunk[] = [];
  let open: TextHunk | null = null;
  let i = 0;
  let j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && left[start + i] === right[start + j]) {
      open = null;
      i++;
      j++;
      continue;
    }
    if (!open) {
      open = { leftStart: start + i + 1, leftLines: [], rightStart: start + j + 1, rightLines: [] };
      hunks.push(open);
    }
    if (j >= m || (i < n && lcs[(i + 1) * (m + 1) + j]! >= lcs[i * (m + 1) + j + 1]!)) open.leftLines.push(left[start + i++]!);
    else open.rightLines.push(right[start + j++]!);
  }
  return hunks;
}

/** Appends to `changes` every path where the two JSON values differ, in document order (left's keys first). */
function diffJson(left: unknown, right: unknown, path: string, changes: JsonChange[]): void {
  if (Array.isArray(left) && Array.isArray(right)) {
    for (let i = 0; i < Math.max(left.length, right.length); i++) {
      const at = `${path}[${i}]`;
      if (i >= right.length) changes.push({ path: at, status: 'onlyLeft', left: left[i] });
      else if (i >= left.length) changes.push({ path: at, status: 'onlyRight', right: right[i] });
      else diffJson(left[i], right[i], at, changes);
    }
  } else if (isRecord(left) && isRecord(right)) {
    for (const key of new Set([...Object.keys(left), ...Object.keys(right)])) {
      const at = path + member(key);
      if (!Object.hasOwn(right, key)) changes.push({ path: at, status: 'onlyLeft', left: left[key] });
      else if (!Object.hasOwn(left, key)) changes.push({ path: at, status: 'onlyRight', right: right[key] });
      else diffJson(left[key], right[key], at, changes);
    }
  } else if (!sameValue(left, right)) {
    // Different scalars, or values of different types: reported whole.
    changes.push({ path, status: 'changed', left, right });
  }
}

/** `.name` for a plain name, `["any key"]` otherwise. */
function member(key: string): string {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(key) ? `.${key}` : `[${JSON.stringify(key)}]`;
}

function withoutXDeath(headers: Record<string, unknown>): Record<string, unknown> {
  const { 'x-death': _, ...rest } = headers;
  return rest;
}

/** Entry n against entry n, most recent first, as the broker orders them. */
function diffXDeath(left: XDeathEntry[], right: XDeathEntry[]): XDeathDiff[] {
  return Array.from({ length: Math.max(left.length, right.length) }, (_, position) => {
    const fields = diffFields({ ...left[position] }, { ...right[position] });
    return { position, status: overall(fields), fields };
  });
}

/** One status for a group of fields: on one side only when every field is, else changed unless all are equal. */
function overall(fields: FieldDiff[]): FieldStatus {
  for (const side of ['onlyLeft', 'onlyRight'] as const) {
    if (fields.length > 0 && fields.every((f) => f.status === side)) return side;
  }
  return fields.every((f) => f.status === 'equal') ? 'equal' : 'changed';
}

/** Every name on either side, sorted, with how its values compare. */
function diffFields(left: Record<string, unknown>, right: Record<string, unknown>): FieldDiff[] {
  const names = [...new Set([...Object.keys(left), ...Object.keys(right)])].sort();
  return names.map((name) => {
    const inLeft = Object.hasOwn(left, name);
    const inRight = Object.hasOwn(right, name);
    if (!inRight) return { name, status: 'onlyLeft', left: left[name] };
    if (!inLeft) return { name, status: 'onlyRight', right: right[name] };
    const status = sameValue(left[name], right[name]) ? 'equal' : 'changed';
    return { name, status, left: left[name], right: right[name] };
  });
}

/** Deep equality of JSON values; object key order does not matter. */
function sameValue(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) || Array.isArray(b)) {
    return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((x, i) => sameValue(x, b[i]));
  }
  if (isRecord(a) && isRecord(b)) {
    const keys = Object.keys(a);
    return keys.length === Object.keys(b).length && keys.every((k) => Object.hasOwn(b, k) && sameValue(a[k], b[k]));
  }
  return false;
}
