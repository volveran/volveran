// Pure Decision logic (no I/O): reading a Decision from a request, which
// Messages may take it, and how a Checkout's Decisions become the summary
// shown before Apply and the ordered plan Apply carries out. The Decision
// types themselves live in src/shared/decisions.ts (the web UI uses them too).
import { isRecord } from '../is-record.js';
import type {
  ActionDecision,
  Decision,
  DecisionKind,
  DecisionSummaryLine,
  MoveDestination,
} from '../../shared/decisions.js';
import type { Delivery } from './message-view.js';
import { parseKind } from './parse-kind.js';
import { replayOrigin } from './replay-origin.js';

export type { ActionDecision, Decision, DecisionKind, DecisionSummaryLine, MoveDestination };

const KINDS: readonly DecisionKind[] = ['keep', 'discard', 'replay', 'move'];

/** Reads a Decision from untrusted input (an API request body). */
export function parseDecision(input: unknown): { ok: true; decision: Decision } | { ok: false; error: string } {
  const parsed = parseKind(input, KINDS, 'Decision');
  if (!parsed.ok) return parsed;
  const raw = input as Record<string, unknown>;
  switch (parsed.kind) {
    case 'keep':
    case 'replay':
      return { ok: true, decision: { kind: parsed.kind } };
    case 'discard': {
      const reason = typeof raw.reason === 'string' ? raw.reason.trim() : '';
      if (reason === '') return { ok: false, error: 'A Discard needs a "reason": it is recorded in the Audit Entry.' };
      return { ok: true, decision: { kind: 'discard', reason } };
    }
    case 'move': {
      const destination = parseDestination(raw.destination);
      if (typeof destination === 'string') return { ok: false, error: destination };
      return { ok: true, decision: { kind: 'move', destination } };
    }
  }
}

/** A Move destination, or why it isn't one. */
function parseDestination(d: unknown): MoveDestination | string {
  const shape = 'A Move needs a "destination": { "queue": "<name>" } or { "exchange": "<name>", "routingKey": "<key>" }.';
  if (!isRecord(d)) return shape;
  if ('queue' in d && 'exchange' in d) return 'A Move destination is either a queue or an exchange with a routing key, not both.';
  if ('queue' in d) {
    if (typeof d.queue !== 'string' || d.queue === '') return 'A Move to a queue needs a queue name.';
    return { queue: d.queue };
  }
  if ('exchange' in d) {
    if (typeof d.exchange !== 'string') return shape;
    if (d.exchange === '') return 'A Move through the default exchange is a Move to a queue: give { "queue": "<name>" } instead.';
    if (typeof d.routingKey !== 'string') return 'A Move to an exchange needs a "routingKey" (it may be empty).';
    return { exchange: d.exchange, routingKey: d.routingKey };
  }
  return shape;
}

/**
 * Why `decision` can't be given to any Message of a Checkout of
 * `sourceQueue`, or null when it can.
 */
export function decisionNotAllowed(decision: Decision, sourceQueue: string): string | null {
  if (decision.kind === 'move' && 'queue' in decision.destination && decision.destination.queue === sourceQueue) {
    return `The Messages are already in "${sourceQueue}": Move them to another queue, or Keep them.`;
  }
  return null;
}

/** Why this Message can't take `decision`, or null when it can. */
export function messageCannotTake(decision: Decision, message: Pick<Delivery, 'properties'>): string | null {
  if (decision.kind === 'replay') {
    const origin = replayOrigin(message.properties.headers);
    return origin.ok ? null : origin.reason;
  }
  return null;
}

export interface ApplyStep {
  handle: number;
  decision: ActionDecision;
}

export interface ApplyPlan {
  /** What Apply does, in the order it does it. */
  steps: ApplyStep[];
  /** Messages left as Keep: Apply doesn't touch them, they go back to the queue. */
  kept: number[];
}

/**
 * Builds the Apply plan for the Messages of a Checkout (`handles`, in
 * Checkout order) and their Decisions. Steps follow Checkout order, the order
 * the Operator sees; Decisions for handles not in the Checkout are ignored.
 */
export function buildApplyPlan(handles: readonly number[], decisions: ReadonlyMap<number, Decision>): ApplyPlan {
  const plan: ApplyPlan = { steps: [], kept: [] };
  for (const handle of handles) {
    const decision = decisions.get(handle) ?? { kind: 'keep' };
    if (decision.kind === 'keep') plan.kept.push(handle);
    else plan.steps.push({ handle, decision });
  }
  return plan;
}

const SUMMARY_ORDER: DecisionKind[] = ['discard', 'replay', 'move', 'keep'];

/** Sorts queue destinations by name before exchange destinations. */
function destinationKey(d: MoveDestination): string {
  return 'queue' in d ? `0 ${d.queue}` : `1 ${d.exchange}\u0000${d.routingKey}`;
}

/**
 * Counts the Messages of a Checkout per Decision (Moves per destination,
 * destinations by name), in a fixed order with Keep last. Kinds nobody chose
 * are left out.
 */
export function summarizeDecisions(
  handles: readonly number[],
  decisions: ReadonlyMap<number, Decision>,
): DecisionSummaryLine[] {
  const counts = new Map<string, DecisionSummaryLine>();
  for (const handle of handles) {
    const decision = decisions.get(handle) ?? { kind: 'keep' };
    const key = decision.kind === 'move' ? `move:${destinationKey(decision.destination)}` : decision.kind;
    const line: DecisionSummaryLine =
      counts.get(key) ??
      (decision.kind === 'move'
        ? { kind: 'move', destination: decision.destination, count: 0 }
        : { kind: decision.kind, count: 0 });
    line.count++;
    counts.set(key, line);
  }
  return [...counts.values()].sort(
    (a, b) =>
      SUMMARY_ORDER.indexOf(a.kind) - SUMMARY_ORDER.indexOf(b.kind) ||
      (a.kind === 'move' && b.kind === 'move'
        ? destinationKey(a.destination).localeCompare(destinationKey(b.destination))
        : 0),
  );
}
