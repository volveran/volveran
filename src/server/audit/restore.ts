// Restore: republish the Message a Discard removed, from the copy in its
// Audit Entry, to the queue it was Discarded from or to another existing
// queue in the same vhost, as the signed-in Operator.
//
// Same republish rules as Replay (republishOptions in ../apply/republish.ts,
// ADR 0005): body, properties and headers as stored, without `CC`, `BCC` and
// the dead-letter headers, plus a new `x-volveran-replay-id` and
// `x-volveran-from`; published through the default exchange on a confirm
// channel with `mandatory`, on a connection of its own, so a Message the
// broker cannot route is reported as failed. One the broker refuses (no write
// permission) is failed too, and answers 403 `broker_permission_denied`
// naming the exchange and the permission. The Restore writes
// its own Audit Entry (action `restore`, `restoreOf` the Discard, and the
// replay id it published with), `pending` before the publish. A Discard whose body retention evicted cannot be
// Restored.
import { randomUUID } from 'node:crypto';
import type * as amqp from 'amqplib';
import { openAmqpConnection } from '../amqp-connection.js';
import { permissionRefused, type BrokerCredentials } from '../broker-credentials.js';
import { ConfirmPublisher, type DescribeRefusal } from '../apply/publisher.js';
import { republishOptions } from '../apply/republish.js';
import { HttpError, InvalidRequestError } from '../http-error.js';
import type { Operator } from '../operator.js';
import type { ProfileAccess } from '../profile-access.js';
import { profileHasVhost, type QueueRef } from '../profiles.js';
import { requireTypedQueueName } from '../protected-profile.js';
import type { AuditEntry, AuditStore } from './audit-store.js';

export type RestoreErrorCode =
  | 'audit_entry_not_found'
  | 'confirmation_required'
  | 'not_restorable'
  | 'body_expired'
  | 'outcome_uncertain'
  | 'discard_in_progress'
  | 'already_restored'
  | 'restore_in_progress'
  | 'profile_not_found'
  | 'queue_not_found';

const STATUS: Record<RestoreErrorCode, number> = {
  audit_entry_not_found: 404,
  confirmation_required: 400,
  not_restorable: 422,
  body_expired: 410,
  outcome_uncertain: 409,
  discard_in_progress: 409,
  already_restored: 409,
  restore_in_progress: 409,
  profile_not_found: 422,
  queue_not_found: 422,
};

export class RestoreError extends HttpError<RestoreErrorCode> {
  constructor(code: RestoreErrorCode, message: string) {
    super(STATUS[code], code, message);
    this.name = 'RestoreError';
  }
}

export interface RestoreRequest {
  /** The Operator's confirmation; must be `true`. */
  confirm?: unknown;
  /**
   * For a Discard whose outcome is `pending` or `uncertain`: the Operator
   * accepts that the Message may still be in the queue, so the Restore may
   * duplicate it. Must be `true` for those.
   */
  confirmUncertain?: unknown;
  /** An existing queue in the same vhost; defaults to the queue the Message was Discarded from. */
  queue?: unknown;
  /** On a Protected Profile: the destination queue's name, typed exactly. */
  confirmQueueName?: unknown;
}

export class RestoreService {
  private readonly running = new Set<number>();

  constructor(
    private readonly audit: AuditStore,
    /** Whether Checkout `id` is still active or Applying in this process. */
    private readonly checkoutRunning: (id: string) => boolean,
  ) {}

  /**
   * Restores the Message of Audit Entry `id`; returns the Restore's own Audit
   * Entry (outcome `done` or `failed`). `target` is the entry's Broker Profile
   * from the access check, null when it is no longer configured.
   */
  async restore(
    id: number,
    request: RestoreRequest | undefined,
    operator: Operator,
    target: ProfileAccess | null,
  ): Promise<AuditEntry> {
    const discard = await this.audit.get(id);
    if (!discard) throw new RestoreError('audit_entry_not_found', `No Audit Entry ${id}.`);
    if (request?.confirm !== true) {
      throw new RestoreError('confirmation_required', 'Restore needs the Operator\'s confirmation: send { "confirm": true }.');
    }
    if (request.queue !== undefined && (typeof request.queue !== 'string' || request.queue === '')) {
      throw new InvalidRequestError('"queue" must be the name of an existing queue.');
    }
    const queue = (request.queue as string | undefined) ?? discard.queue;
    const message = discard.message;
    if (discard.action !== 'discard' || discard.outcome === 'failed' || !message) {
      throw new RestoreError(
        'not_restorable',
        `Audit Entry ${id} is not a carried-out Discard, so it has no removed Message to Restore.`,
      );
    }
    if (discard.bodyExpiredAt) {
      throw new RestoreError(
        'body_expired',
        `The body of the Message of Audit Entry ${id} expired on ${discard.bodyExpiredAt.toISOString()}: retention evicted it (Discarded bodies are kept for a limited time and up to a total size), so it cannot be Restored. The Audit Entry keeps its properties and headers.`,
      );
    }
    if (!target) {
      throw new RestoreError('profile_not_found', `Broker Profile "${discard.profile}" is no longer configured.`);
    }
    const { profile, role, management } = target;
    requireTypedQueueName(profile, queue, request, 'Restore');
    // `pending` is also the normal state of a step being carried out right now:
    // only once its Checkout is gone (ended, lost, or Volverán restarted) can
    // it no longer finish on its own.
    if (discard.outcome === 'pending' && discard.checkoutId !== null && this.checkoutRunning(discard.checkoutId)) {
      throw new RestoreError(
        'discard_in_progress',
        `The Discard of Audit Entry ${id} is still being carried out by Checkout ${discard.checkoutId}. Wait for its Apply to finish; its outcome will then be known.`,
      );
    }
    if (discard.outcome !== 'done' && request.confirmUncertain !== true) {
      throw new RestoreError(
        'outcome_uncertain',
        `The Discard of Audit Entry ${id} did not finish in a known state (${discard.outcome}): the Message may still be in queue "${discard.queue}" (vhost "${discard.vhost}"). Check that queue first; to Restore anyway, accepting a possible duplicate, send { "confirm": true, "confirmUncertain": true }.`,
      );
    }
    if (this.running.has(id)) throw new RestoreError('restore_in_progress', `Audit Entry ${id} is being Restored.`);

    // Claimed before the store is asked about earlier Restores, so a second request for the same entry is refused.
    this.running.add(id);
    try {
      const earlier = (await this.audit.list({ restoreOf: id })).find((e) => e.outcome !== 'failed');
      if (earlier) {
        throw new RestoreError(
          'already_restored',
          `The Message of Audit Entry ${id} was already Restored to "${earlier.destination?.queue}" (Audit Entry ${earlier.id}).`,
        );
      }
      if (!profileHasVhost(profile, discard.vhost) || !(await management.getQueue(discard.vhost, queue))) {
        throw new RestoreError(
          'queue_not_found',
          `Queue "${queue}" does not exist in vhost "${discard.vhost}" (or Broker Profile "${profile.name}" cannot see it). Pick an existing queue.`,
        );
      }
      // Read after the checks: retention may have evicted it meanwhile.
      const body = await this.audit.body(id);
      if (!body) {
        throw new RestoreError('body_expired', `The body of the Message of Audit Entry ${id} is no longer stored, so it cannot be Restored.`);
      }

      // The Operator's own token on a profile with `credentials: operatorToken`.
      const credentials = target.credentials();
      const replayId = randomUUID();
      const entryId = await this.audit.record({
        at: new Date(),
        operator,
        role,
        brokerUser: credentials.brokerUser,
        profile: profile.name,
        vhost: discard.vhost,
        queue: discard.queue,
        messageId: discard.messageId,
        action: 'restore',
        reason: null,
        destination: { exchange: '', routingKey: queue, queue },
        checkoutId: null,
        restoreOf: id,
        replayId,
        message: null,
      });
      const options = republishOptions(
        { ...message.properties, headers: message.headers },
        { replayId, from: discard.queue },
      );
      const refusal = permissionRefused(
        profile,
        credentials.brokerUser,
        { type: 'exchange', name: '', vhost: discard.vhost },
        'write',
        'A Restore publishes through the default exchange, so the broker user needs write permission on it.',
      );
      const failure = await publish({ profile, vhost: discard.vhost, queue }, credentials, body, options, () => refusal.message);
      await this.audit.setOutcome(entryId, failure ? 'failed' : 'done', failure?.reason ?? null);
      // Like a refused read or configure: the Operator learns which permission is missing.
      if (failure?.refused) throw refusal;
      return (await this.audit.get(entryId))!;
    } finally {
      this.running.delete(id);
    }
  }
}

/**
 * Publishes to `queue` through the default exchange on a connection of its
 * own; returns why it failed (`refused`: the broker refused write
 * permission), or null.
 */
async function publish(
  { profile, vhost, queue }: QueueRef,
  credentials: BrokerCredentials,
  body: Buffer,
  options: amqp.Options.Publish,
  describeRefusal: DescribeRefusal,
): Promise<{ reason: string; refused?: boolean } | null> {
  let connection: amqp.ChannelModel;
  try {
    connection = await openAmqpConnection(profile, credentials, vhost, `volveran restore ${vhost} ${queue}`);
  } catch (err) {
    return { reason: (err as Error).message };
  }
  try {
    const result = await new ConfirmPublisher(connection, describeRefusal).publish('', queue, body, options);
    return result.ok ? null : result;
  } finally {
    await connection.close().catch(() => {});
  }
}
