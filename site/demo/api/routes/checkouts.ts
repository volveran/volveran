// The triage loop's routes, answered by the simulator (../simulator):
//
//   POST   /profiles/{profile}/vhosts/{vhost}/queues/{queue}/checkouts { overrideConsumers? } → 201 { checkout }
//   GET    /checkouts/{id}                    → { checkout }
//   GET    /checkouts/{id}/messages/{handle}  → { message }
//   POST   /checkouts/{id}/heartbeat          → { checkout }
//   DELETE /checkouts/{id}, POST /checkouts/{id}/end → { checkout } ended
//   POST   /checkouts/{id}/matching   { filter }            → { handles, count }
//   POST   /checkouts/{id}/decisions  { handles, decision } → { checkout, rejected }
//   POST   /checkouts/{id}/apply      { confirm, confirmQueueName?, rate?, canary? } → 202 { checkout }
//   POST   /checkouts/{id}/apply/stop, /apply/continue → { checkout }
//
// Request checks and their messages follow src/server/routes/checkouts.ts,
// decisions.ts and apply.ts.
import { requireTypedQueueName } from '../../../../src/server/protected-profile.js';
import type { Decision, MoveDestination } from '../../../../src/shared/decisions.js';
import { HttpError } from '../../../../src/server/http-error.js';
import { json, type Router } from '../router.js';
import { invalid } from '../simulator/audit-log.js';
import { parseFilter } from '../simulator/filters.js';
import { profileSettings } from '../simulator/profile-settings.js';
import { profileNamed, vhostOf, type DemoState } from '../state.js';

export function registerCheckoutRoutes(router: Router, state: DemoState) {
  const { checkouts } = state;

  router.on('POST', '/profiles/{profile}/vhosts/{vhost}/queues/{queue}/checkouts', ({ params, body }) => {
    const request = body ?? {};
    if (!isRecord(request)) throw invalid('The request body must be a JSON object.');
    const { overrideConsumers = false } = request;
    if (typeof overrideConsumers !== 'boolean') throw invalid('"overrideConsumers" must be true or false.');
    const profile = profileNamed(state, params.profile!);
    vhostOf(state, params.profile!, params.vhost!);
    const checkout = checkouts.start(profileSettings(profile.summary), { vhost: params.vhost!, queue: params.queue! }, { overrideConsumers });
    return json({ checkout }, 201);
  });

  router.on('GET', '/checkouts/{id}', ({ params }) => json({ checkout: checkouts.get(params.id!) }));

  router.on('GET', '/checkouts/{id}/messages/{handle}', ({ params }) => {
    const raw = params.handle!;
    const handle = Number(raw);
    if (raw === '' || !Number.isSafeInteger(handle)) throw new HttpError(404, 'message_not_found', `"${raw}" is not a Message handle.`);
    checkouts.get(params.id!);
    return json({ message: checkouts.message(params.id!, handle) });
  });

  router.on('POST', '/checkouts/{id}/heartbeat', ({ params }) => json({ checkout: checkouts.heartbeat(params.id!) }));

  const end = async ({ params }: { params: Record<string, string> }) => json({ checkout: await checkouts.end(params.id!) });
  router.on('DELETE', '/checkouts/{id}', end);
  router.on('POST', '/checkouts/{id}/end', end);

  router.on('POST', '/checkouts/{id}/matching', ({ params, body }) => {
    checkouts.get(params.id!);
    const parsed = parseFilter(isRecord(body) ? body.filter : undefined);
    if (!parsed.ok) throw invalid(parsed.error);
    const handles = checkouts.matching(params.id!, parsed.filter);
    return json({ handles, count: handles.length });
  });

  router.on('POST', '/checkouts/{id}/decisions', ({ params, body }) => {
    checkouts.get(params.id!);
    const request = isRecord(body) ? body : {};
    const { handles } = request;
    if (!Array.isArray(handles) || !handles.every((h) => Number.isSafeInteger(h))) throw invalid('"handles" must be a list of Message handles.');
    const parsed = parseDecision(request.decision);
    if (!parsed.ok) throw invalid(parsed.error);
    return json(checkouts.stage(params.id!, handles as number[], parsed.decision));
  });

  router.on('POST', '/checkouts/{id}/apply', ({ params, body }) => {
    checkouts.get(params.id!);
    const request = isRecord(body) ? body : {};
    if (request.confirm !== true) {
      throw new HttpError(
        400,
        'confirmation_required',
        'Apply needs the Operator\'s confirmation: send { "confirm": true } after showing the summary of Decisions.',
      );
    }
    const { protectedProfile, profile, queue, applyConfirmation } = checkouts.get(params.id!);
    if (applyConfirmation.typeQueueName) requireTypedQueueName({ name: profile, protected: protectedProfile }, queue, request, 'Apply');
    return json({ checkout: checkouts.apply(params.id!, { rate: request.rate, canary: request.canary }) }, 202);
  });

  router.on('POST', '/checkouts/{id}/apply/stop', ({ params }) => json({ checkout: checkouts.stopApply(params.id!) }));
  router.on('POST', '/checkouts/{id}/apply/continue', ({ params }) => json({ checkout: checkouts.continueApply(params.id!) }));
}

const KINDS = ['keep', 'discard', 'replay', 'move'] as const;

/** A Decision from a request body (src/server/triage/decisions.ts, parseDecision). */
function parseDecision(input: unknown): { ok: true; decision: Decision } | { ok: false; error: string } {
  const kind = isRecord(input) ? input.kind : undefined;
  const choices = `use one of ${KINDS.join(', ')}.`;
  if (typeof kind !== 'string') return { ok: false, error: `A Decision needs a "kind"; ${choices}` };
  if (!(KINDS as readonly string[]).includes(kind)) return { ok: false, error: `"${kind}" is not a Decision; ${choices}` };
  const raw = input as Record<string, unknown>;
  switch (kind as (typeof KINDS)[number]) {
    case 'keep':
      return { ok: true, decision: { kind: 'keep' } };
    case 'replay':
      return { ok: true, decision: { kind: 'replay' } };
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

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
