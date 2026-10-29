// The comparison of two Messages (src/server/triage/message-diff.ts) as the
// API sends it with GET /api/checkouts/:id/compare. Types only, shared by the
// server and the web app.
import type { MessageDetail } from './checkout.js';

/** How one named field compares: the same on both sides, different, or set on one side only. */
export type FieldStatus = 'equal' | 'changed' | 'onlyLeft' | 'onlyRight';

export interface FieldDiff {
  name: string;
  status: FieldStatus;
  /** Absent when the field is only on the right. */
  left?: unknown;
  /** Absent when the field is only on the left. */
  right?: unknown;
}

/** The x-death entries at one position (0 is the most recent), compared field by field. */
export interface XDeathDiff {
  position: number;
  status: FieldStatus;
  fields: FieldDiff[];
}

/** A JSON value that differs at a JSON path such as `$.order.items[0].sku`. */
export interface JsonChange {
  path: string;
  status: Exclude<FieldStatus, 'equal'>;
  left?: unknown;
  right?: unknown;
}

/** A run of lines that differ; starts are 1-based line numbers, and the lines may be empty on one side. */
export interface TextHunk {
  leftStart: number;
  leftLines: string[];
  rightStart: number;
  rightLines: string[];
}

export type BodyDiff =
  | { kind: 'json'; equal: boolean; changes: JsonChange[] }
  | { kind: 'text'; equal: boolean; hunks: TextHunk[] }
  | { kind: 'binary'; equal: boolean; leftSize: number; rightSize: number; firstDifferentByte: number | null }
  /** Bodies of different kinds: nothing finer to compare. */
  | { kind: 'mixed'; equal: false; leftKind: MessageDetail['body']['kind']; rightKind: MessageDetail['body']['kind'] };

export interface MessageDiff {
  properties: FieldDiff[];
  /** Every header except `x-death`, which `xDeath` compares entry by entry. */
  headers: FieldDiff[];
  xDeath: XDeathDiff[];
  /** Null when neither Message has Failure Details. */
  failureDetails: FieldDiff[] | null;
  body: BodyDiff;
}

/** What GET /api/checkouts/:id/compare (and its approval twin) answer. */
export interface MessageComparison {
  left: MessageDetail;
  right: MessageDetail;
  diff: MessageDiff;
}
