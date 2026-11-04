// Carrying out an Apply plan against the demo's broker, one Message at a
// time, as src/server/apply/executor.ts does (ADR 0001): before each step it
// asks whether to go on; for each attempted step an Audit Entry is written
// `pending` (a Discard with the full Message) before the broker is touched,
// then given its outcome. A failed or not attempted step leaves its Message
// held, so it falls back to Keep when the Checkout ends.
//
// Extension points:
// - `rate`: Replay and Move steps start at least 1/rate apart (the server's
//   pacer); Discards are not paced, and a stop wakes the wait.
// - `canary`: the hooks of a Canary, as checkout/canary.ts gives the
//   server's executor: its step goes first and alone, `beforePublish` runs
//   once its Audit Entry is written, `afterStep` once it settled, and may
//   wait (the Watch Window, then Continue or Stop).
// - HANDLERS: what each Decision does on the broker. A Replay reaches the
//   work queue's consumer, which decides whether the Message dies again
//   (broker.ts).
import { pacer } from '../../../../src/server/apply/pacing.js';
import { STOP_REASONS } from '../../../../src/server/apply/stop-reasons.js';
import type { AuditAction, AuditDestination } from '../../../../src/shared/audit.js';
import type { MessageOutcome } from '../../../../src/shared/checkout.js';
import { destinationLabel, type ActionDecision, type Decision, type MoveDestination } from '../../../../src/shared/decisions.js';
import type { Role } from '../../../../src/shared/roles.js';
import type { AuditLog } from './audit-log.js';
import type { AmqpProperties, BrokerMessage, DemoBroker } from './broker.js';
import { REPLAY_ID_HEADER } from './filters.js';
import { messageIdOf, replayOrigin } from './message-view.js';

/** Who acts, on which queue, as each Audit Entry records it. */
export interface ApplyTarget {
  profile: string;
  vhost: string;
  queue: string;
  checkoutId: string;
  operator: string;
  role: Role;
  brokerUser: string;
}

export interface ApplyStep {
  handle: number;
  decision: ActionDecision;
}

/** What a step's Audit Entry records, decided before the broker is touched. */
export interface AuditDetails {
  action: Extract<AuditAction, 'discard' | 'replay' | 'move'>;
  reason: string | null;
  destination: AuditDestination | null;
  /** A Discard keeps the full Message, body included; the others its properties and headers. */
  copy: 'full' | 'headers';
  replayId: string | null;
}

export type StepResult = { status: 'done' } | { status: 'failed'; reason: string };

export interface StepContext {
  broker: DemoBroker;
  target: ApplyTarget;
}

export interface DecisionHandler<D extends ActionDecision> {
  audit(decision: D, message: BrokerMessage): AuditDetails;
  execute(decision: D, message: BrokerMessage, ctx: StepContext, details: AuditDetails): StepResult;
}

/** The Canary's hooks: see checkout/canary.ts on the server. */
export interface CanaryHooks {
  handle: number;
  beforePublish(entryId: number, replayId: string | null): void;
  afterStep(outcome: MessageOutcome): Promise<void>;
}

export interface ApplyRun {
  /** The Steps in Checkout order, and the Messages left as Keep. */
  steps: ApplyStep[];
  kept: number[];
  /** The held Messages, by handle, in Checkout order. */
  messages: ReadonlyMap<number, BrokerMessage>;
  target: ApplyTarget;
  broker: DemoBroker;
  audit: AuditLog;
  rate: number | null;
  /** Asked before every step: null to go on, or why no further step is attempted. */
  stopReason(): string | null;
  stopSignal: AbortSignal;
  /** As each step settles (not for kept Messages). */
  onStep(outcome: MessageOutcome): void;
  /** As soon as a step is done: its Message is no longer held. */
  onDone(handle: number): void;
  canary?: CanaryHooks;
}

/** Runs the plan; one outcome per Message, in Checkout order. */
export async function executeApply(run: ApplyRun): Promise<MessageOutcome[]> {
  const { messages, target, audit } = run;
  const pace = pacer(run.rate);
  const outcomes = new Map<number, MessageOutcome>();
  const outcome = (handle: number, decision: Decision, status: MessageOutcome['status'], reason: string | null = null) => {
    const o: MessageOutcome = { handle, messageId: messageIdOf(messages.get(handle)), decision, status, reason };
    outcomes.set(handle, o);
    if (status !== 'kept') run.onStep(o);
  };
  for (const handle of run.kept) outcome(handle, { kind: 'keep' }, 'kept');
  const canary = run.canary;
  const steps = canary ? [...run.steps.filter((s) => s.handle === canary.handle), ...run.steps.filter((s) => s.handle !== canary.handle)] : run.steps;
  for (const { handle, decision } of steps) {
    const isCanary = handle === canary?.handle;
    const message = messages.get(handle);
    if (message && decision.kind !== 'discard') await pace.wait(run.stopSignal);
    const stop = message ? run.stopReason() : STOP_REASONS.checkoutNotActive;
    if (!message || stop !== null) {
      outcome(handle, decision, 'not-attempted', stop ?? STOP_REASONS.checkoutNotActive);
      continue;
    }
    const handler = handlerFor(decision);
    const details = handler.audit(decision, message);
    const { headers, ...properties } = message.properties;
    const entryId = audit.record({
      at: new Date().toISOString(),
      operatorId: target.operator,
      operatorName: target.operator,
      role: target.role,
      approverId: null,
      approverName: null,
      brokerUser: target.brokerUser,
      profile: target.profile,
      vhost: target.vhost,
      queue: target.queue,
      messageId: messageIdOf(message),
      action: details.action,
      reason: details.reason,
      destination: details.destination,
      checkoutId: target.checkoutId,
      restoreOf: null,
      replayId: details.replayId,
      filter: null,
      messageCount: null,
      rate: run.rate,
      rule: null,
      rulePassId: null,
      canary: isCanary,
      message: { properties: { ...properties }, headers: structuredClone(headers ?? {}), body: details.copy === 'full' ? message.content : null },
    });
    if (isCanary) canary.beforePublish(entryId, details.replayId);
    let result: StepResult;
    try {
      result = handler.execute(decision, message, { broker: run.broker, target }, details);
    } catch (err) {
      result = { status: 'failed', reason: (err as Error).message };
    }
    if (result.status === 'done') run.onDone(handle);
    outcome(handle, decision, result.status, result.status === 'failed' ? result.reason : null);
    audit.setOutcome(entryId, result.status, result.status === 'failed' ? result.reason : null);
    if (isCanary) await canary.afterStep(outcomes.get(handle)!);
  }
  return [...messages.keys()].flatMap((handle) => {
    const o = outcomes.get(handle);
    return o ? [o] : [];
  });
}

const discard: DecisionHandler<{ kind: 'discard'; reason: string }> = {
  audit: (decision) => ({ action: 'discard', reason: decision.reason, destination: null, copy: 'full', replayId: null }),
  execute(_decision, message, { broker, target }) {
    broker.ack(target, message);
    return { status: 'done' };
  },
};

const replay: DecisionHandler<{ kind: 'replay' }> = {
  audit(_decision, message) {
    const origin = replayOrigin(message.properties.headers);
    return {
      action: 'replay',
      reason: null,
      destination: origin.ok ? { exchange: '', routingKey: origin.queue, queue: origin.queue } : null,
      copy: 'headers',
      replayId: crypto.randomUUID(),
    };
  },
  execute(_decision, message, ctx, { replayId }) {
    const origin = replayOrigin(message.properties.headers);
    if (!origin.ok) return { status: 'failed', reason: origin.reason };
    return publishHeld(ctx, message, '', origin.queue, replayId!, (reason) => `Could not Replay the Message to "${origin.queue}" (does the queue still exist?): ${reason} It stays in the queue.`);
  },
};

function moveRoute(destination: MoveDestination): { exchange: string; routingKey: string; queue: string | null } {
  return 'queue' in destination
    ? { exchange: '', routingKey: destination.queue, queue: destination.queue }
    : { exchange: destination.exchange, routingKey: destination.routingKey, queue: null };
}

const move: DecisionHandler<{ kind: 'move'; destination: MoveDestination }> = {
  audit: ({ destination }) => ({ action: 'move', reason: null, destination: moveRoute(destination), copy: 'headers', replayId: crypto.randomUUID() }),
  execute({ destination }, message, ctx, { replayId }) {
    const { exchange, routingKey } = moveRoute(destination);
    return publishHeld(
      ctx,
      message,
      exchange,
      routingKey,
      replayId!,
      (reason) =>
        `Could not Move the Message to ${destinationLabel(destination)} (does it still exist, and does it route the Message somewhere?): ${reason} It stays in the queue.`,
    );
  },
};

function handlerFor(decision: ActionDecision): DecisionHandler<ActionDecision> {
  const handlers = { discard, replay, move } as Record<ActionDecision['kind'], DecisionHandler<ActionDecision>>;
  return handlers[decision.kind];
}

/** Publishes a copy of the held Message with cleaned headers (src/server/apply/republish.ts), then acks it. */
function publishHeld(
  { broker, target }: StepContext,
  message: BrokerMessage,
  exchange: string,
  routingKey: string,
  replayId: string,
  failure: (reason: string) => string,
): StepResult {
  const reached = broker.publish(target.vhost, exchange, routingKey, { properties: republished(message.properties, replayId, target.queue), content: message.content });
  if (reached.length === 0) return { status: 'failed', reason: failure('The broker could not route it.') };
  broker.ack(target, message);
  return { status: 'done' };
}

const REMOVED_HEADERS = new Set(['CC', 'BCC', 'x-death', 'x-delivery-count', 'x-acquired-count', 'x-original-exchange', 'x-original-routingKey', 'MT-Reason']);
const REMOVED_PREFIXES = ['x-first-death-', 'x-last-death-', 'x-exception-', 'MT-Fault-', 'MT-Host-'];

/** The properties a republished Message carries: the same, with the dead-letter and Failure Details headers removed and provenance added. */
export function republished(properties: AmqpProperties, replayId: string, from: string): AmqpProperties {
  const kept = Object.entries(properties.headers ?? {}).filter(([name]) => !REMOVED_HEADERS.has(name) && !REMOVED_PREFIXES.some((p) => name.startsWith(p)));
  return { ...properties, headers: { ...Object.fromEntries(kept), [REPLAY_ID_HEADER]: replayId, 'x-volveran-from': from } };
}
