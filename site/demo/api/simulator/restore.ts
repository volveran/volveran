// Restore in the demo: republishes the Message a Discard removed, from the
// copy in its Audit Entry, to the queue it was Discarded from or to another
// existing queue in the same vhost, as src/server/audit/restore.ts does.
//
// Same republish rules as Replay (apply.ts `republished`): the dead-letter and
// Failure Details headers removed, a new `x-volveran-replay-id` and
// `x-volveran-from` added, so a Restored Message that dies again is Died
// Again. The Restore writes its own Audit Entry (action `restore`, `restoreOf`
// the Discard, the replay id it published with), `pending` before the publish.
//
// Left out, as they cannot happen here: a body evicted by retention (the demo
// keeps every body for the page's life), a Discard whose outcome is not
// `done` (the demo's Discards always finish), a broker refusing write
// permission, and a Restore still running when another one asks.
import { requireTypedQueueName } from '../../../../src/server/protected-profile.js';
import type { AuditEntryJson } from '../../../../src/shared/audit.js';
import { HttpError } from '../../../../src/server/http-error.js';
import { republished } from './apply.js';
import type { AuditLog } from './audit-log.js';
import type { AmqpProperties, DemoBroker } from './broker.js';
import type { ProfileSettings } from './profile-settings.js';

export interface RestoreDeps {
  audit: AuditLog;
  broker: DemoBroker;
  operator: string;
  /** The settings of a configured Broker Profile; null for one that is not. */
  profile(name: string): ProfileSettings | null;
  /** Whether the Broker Profile can see the vhost. */
  hasVhost(profile: string, vhost: string): boolean;
}

/** Restores the Message of Audit Entry `id`; returns the Restore's own Audit Entry. Throws as the server answers. */
export function restore(deps: RestoreDeps, id: number, request: unknown): AuditEntryJson {
  const { audit, broker, operator } = deps;
  const discard = audit.get(id);
  if (!discard) throw refusal('audit_entry_not_found', `No Audit Entry ${id}.`);
  const body = isRecord(request) ? request : {};
  if (body.confirm !== true) throw refusal('confirmation_required', 'Restore needs the Operator\'s confirmation: send { "confirm": true }.');
  if (body.queue !== undefined && (typeof body.queue !== 'string' || body.queue === '')) {
    throw new HttpError(400, 'invalid_request', '"queue" must be the name of an existing queue.');
  }
  const queue = (body.queue as string | undefined) ?? discard.queue;
  const stored = audit.body(id);
  if (discard.action !== 'discard' || discard.outcome === 'failed' || !discard.message || !stored) {
    throw refusal('not_restorable', `Audit Entry ${id} is not a carried-out Discard, so it has no removed Message to Restore.`);
  }
  const profile = deps.profile(discard.profile);
  if (!profile) throw refusal('profile_not_found', `Broker Profile "${discard.profile}" is no longer configured.`);
  requireTypedQueueName(profile, queue, body, 'Restore');
  const earlier = audit.restoresOf(id).find((e) => e.outcome !== 'failed');
  if (earlier) {
    throw refusal('already_restored', `The Message of Audit Entry ${id} was already Restored to "${earlier.destination?.queue}" (Audit Entry ${earlier.id}).`);
  }
  if (!deps.hasVhost(profile.name, discard.vhost) || !broker.queue({ vhost: discard.vhost, queue })) {
    throw refusal(
      'queue_not_found',
      `Queue "${queue}" does not exist in vhost "${discard.vhost}" (or Broker Profile "${profile.name}" cannot see it). Pick an existing queue.`,
    );
  }

  const replayId = crypto.randomUUID();
  const entryId = audit.record({
    at: new Date().toISOString(),
    operatorId: operator,
    operatorName: operator,
    role: 'admin',
    approverId: null,
    approverName: null,
    brokerUser: profile.brokerUser,
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
    filter: null,
    messageCount: null,
    rate: null,
    rule: null,
    rulePassId: null,
    canary: false,
    message: null,
  });
  const properties = { ...discard.message.properties, headers: structuredClone(discard.message.headers) } as AmqpProperties;
  const reached = broker.publish(discard.vhost, '', queue, { properties: republished(properties, replayId, discard.queue), content: stored });
  if (reached.length === 0) audit.setOutcome(entryId, 'failed', `The broker could not route the Message to "${queue}".`);
  else audit.setOutcome(entryId, 'done');
  return audit.get(entryId)!;
}

type RestoreErrorCode = 'audit_entry_not_found' | 'confirmation_required' | 'not_restorable' | 'already_restored' | 'profile_not_found' | 'queue_not_found';

const STATUS: Record<RestoreErrorCode, number> = {
  audit_entry_not_found: 404,
  confirmation_required: 400,
  not_restorable: 422,
  already_restored: 409,
  profile_not_found: 422,
  queue_not_found: 422,
};

function refusal(code: RestoreErrorCode, message: string): HttpError {
  return new HttpError(STATUS[code], code, message);
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
