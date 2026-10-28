// The contract between the Apply executor and the per-Decision handlers
// (discard.ts, replay.ts, move.ts). Each handler owns one
// Decision kind: what its Audit Entry records and how it is carried out on
// the broker.
import type * as amqp from 'amqplib';
import type { AuditAction, AuditDestination } from '../audit/store.js';
import type { Operator } from '../operator.js';
import type { QueueRef } from '../profiles.js';
import type { ActionDecision } from '../triage/decisions.js';
import type { MessageOutcome, OutcomeStatus } from '../../shared/checkout.js';
import type { Role } from '../../shared/roles.js';

export type { MessageOutcome, OutcomeStatus };

/** A Message held by a Checkout (an unacked delivery on the Checkout channel). */
export type HeldMessage = amqp.ConsumeMessage;

/** The queue a Checkout holds Messages from, and who is Applying. */
export interface ApplyTarget extends QueueRef {
  checkoutId: string;
  operator: Pick<Operator, 'id' | 'displayName'>;
  /** The Operator's Role on the Broker Profile, recorded in each Audit Entry. */
  role: Role;
  /** The second Operator who approved this Apply (Protected Profile, Team Mode); null when it needed no Approval. */
  approver: Pick<Operator, 'id' | 'displayName'> | null;
}

/** The outcome of one publish: ok only when confirmed without a preceding basic.return. */
export type PublishResult = { ok: true } | { ok: false; reason: string };

/** What a handler can do on the broker during Apply. */
export interface ApplyContext {
  target: ApplyTarget;
  /** When this Apply started. */
  startedAt: Date;
  /**
   * Acks the Message on the Checkout channel and resolves once the broker has
   * processed the ack. Rejects with a plain Error when the ack was never sent
   * (the Message stays in the queue), with AckUncertainError when it was sent
   * but not confirmed.
   */
  ack(message: HeldMessage): Promise<void>;
  /**
   * Publishes on a confirm channel (apply/publisher.ts), separate from the
   * Checkout channel, with the `mandatory` flag. Resolves `ok` only once the
   * broker has confirmed the publish and not returned it as unroutable; never
   * rejects.
   */
  publish(exchange: string, routingKey: string, content: Buffer, options: amqp.Options.Publish): Promise<PublishResult>;
}

export type StepResult = { status: 'done' } | { status: 'failed'; reason: string };

/** What the Audit Entry of one step records besides who, when and where from. */
export interface AuditDetails {
  action: AuditAction;
  /** Why the Operator did it (Discard); null when the Decision has none. */
  reason: string | null;
  destination: AuditDestination | null;
  /**
   * full: body, properties and headers (Discard, so it can be Restored).
   * headers: the original properties and headers only (Replay, Move, ADR 0005).
   */
  copy: 'full' | 'headers';
  /**
   * The replay id the Message will be published with (Replay, Move), chosen
   * before the Audit Entry is written so the entry records it; null when the
   * action publishes nothing.
   */
  replayId: string | null;
}

export interface DecisionHandler<D extends ActionDecision> {
  audit(decision: D, message: HeldMessage, target: ApplyTarget): AuditDetails;
  /**
   * Carries out the Decision, with the `details` its Audit Entry was written
   * with (a publish uses their replay id). Resolves `done` only once the broker has
   * confirmed it; a failure leaves the Message held, so it falls back to Keep.
   * May throw; the executor reports a throw as failed.
   */
  execute(decision: D, message: HeldMessage, ctx: ApplyContext, details: AuditDetails): Promise<StepResult>;
}

/**
 * Thrown by `ApplyContext.ack` when the ack was sent but the broker never
 * confirmed processing it (the connection dropped): the Message may or may
 * not have been removed. Its Audit Entry is recorded as `uncertain`.
 */
export class AckUncertainError extends Error {
  /**
   * `causeText` is why the round trip failed; `context`, if given, is what had
   * already happened to the Message (e.g. a Move's confirmed publish).
   */
  constructor(
    readonly causeText: string,
    context?: string,
  ) {
    super(
      `${context ? `${context} ` : ''}The connection dropped before the broker confirmed the ack, so the Message may or may not have been removed from the queue: ${causeText}`,
    );
    this.name = 'AckUncertainError';
  }
}
