// Pure (no I/O, no DOM): what a Decision is, and how Decisions read to the
// Operator, e.g. the summary before Apply: "12 Discard, 40 Replay, 3 Move to
// orders.manual, 145 Keep". Shared by the server (API shapes) and the web UI.

/**
 * Where a Move sends a Message: a queue (through the default exchange), or an
 * exchange with a routing key (ADR 0005: re-routing only when the Operator
 * names it).
 */
export type MoveDestination = { queue: string } | { exchange: string; routingKey: string };

/**
 * The action assigned to one Message in a Checkout. Every Message is Keep
 * until told otherwise; nothing reaches the broker until Apply.
 */
export type Decision =
  | { kind: 'keep' }
  /** `reason` is required: it goes into the Audit Entry. */
  | { kind: 'discard'; reason: string }
  | { kind: 'replay' }
  | { kind: 'move'; destination: MoveDestination };

export type DecisionKind = Decision['kind'];

/** A Decision other than Keep: something Apply does on the broker. */
export type ActionDecision = Exclude<Decision, { kind: 'keep' }>;

/** One line of the summary shown before Apply: Discards and Replays counted together, Moves per destination. */
export type DecisionSummaryLine =
  | { kind: 'keep' | 'discard' | 'replay'; count: number }
  | { kind: 'move'; destination: MoveDestination; count: number };

export function destinationLabel(d: MoveDestination): string {
  if ('queue' in d) return d.queue;
  return `exchange ${d.exchange} with ${d.routingKey === '' ? 'an empty routing key' : `routing key ${d.routingKey}`}`;
}

/** "Keep", "Discard", "Replay", "Move to orders.manual". */
export function decisionLabel(d: Decision | DecisionSummaryLine): string {
  switch (d.kind) {
    case 'keep':
      return 'Keep';
    case 'discard':
      return 'Discard';
    case 'replay':
      return 'Replay';
    case 'move':
      return `Move to ${destinationLabel(d.destination)}`;
  }
}

/** The whole summary on one line, e.g. "12 Discard, 40 Replay, 3 Move to orders.manual, 145 Keep". */
export function summaryText(lines: readonly DecisionSummaryLine[]): string {
  if (lines.length === 0) return 'No Messages';
  return lines.map((line) => `${line.count.toLocaleString('en-US')} ${decisionLabel(line)}`).join(', ');
}
