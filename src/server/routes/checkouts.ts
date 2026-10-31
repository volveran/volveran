// Checkout routes: start a Checkout on a queue, read it and its Messages, end it.
//
//   POST   /api/profiles/:profile/vhosts/:vhost/queues/:queue/checkouts  → 201 { checkout }
//          body { overrideConsumers?: boolean }: start even though other consumers read the queue
//   GET    /api/checkouts/:id                                            → { checkout }
//   GET    /api/checkouts/:id/messages/:handle                           → { message }
//   GET    /api/checkouts/:id/compare?a=<handle>&b=<handle>              → { left, right, diff }
//   POST   /api/checkouts/:id/heartbeat  the browser still shows it        → { checkout }
//   DELETE /api/checkouts/:id                                            → { checkout }
//   POST   /api/checkouts/:id/end   same as DELETE, for navigator.sendBeacon
//
// Every /api/checkouts/:id… route (these and routes/decisions.ts) is for the
// Checkout's owner only: another Operator gets 403 `not_checkout_owner`
// before the handler runs, so nothing of the Checkout leaks. In Solo Mode
// there is only one Operator. Each route then resolves the Checkout's
// Broker Profile through the access check (profile-access.ts), with the
// capability `checkout`.
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { CheckoutManager } from '../checkout/manager.js';
import { CheckoutError } from '../checkout/errors.js';
import { InvalidRequestError } from '../http-error.js';
import { isRecord } from '../is-record.js';
import { diffMessages } from '../triage/message-diff.js';
import type { MessageComparison } from '../../shared/message-diff.js';
import { operatorOf } from '../operator.js';
import type { Capability, ProfileAccess, ProfileAccessCheck } from '../profile-access.js';

export interface CheckoutRouteDeps {
  checkouts: CheckoutManager;
  access: ProfileAccessCheck;
}

/**
 * The Broker Profile of the Checkout a request names, through the access
 * check; throws 404 `checkout_not_found` for an unknown id.
 */
export function checkoutAccess(
  { checkouts, access }: CheckoutRouteDeps,
  req: FastifyRequest<{ Params: { id: string } }>,
  capability: Capability,
): ProfileAccess {
  return access.of(operatorOf(req), capability, checkouts.checkout(req.params.id));
}

/** A Message handle from the URL; 404 `message_not_found` when it is not a number. */
export function parseHandle(raw: unknown): number {
  const handle = Number(raw);
  if (typeof raw !== 'string' || raw === '' || !Number.isSafeInteger(handle)) {
    throw new CheckoutError('message_not_found', `"${String(raw)}" is not a Message handle.`);
  }
  return handle;
}

/**
 * The two Messages that `?a=<handle>&b=<handle>` names, side by side with
 * their diff. 400 for a missing handle or the same handle twice, 404 for a
 * handle the Checkout does not hold.
 */
export async function compareMessages(checkouts: CheckoutManager, id: string, query: unknown): Promise<MessageComparison> {
  const { a, b } = isRecord(query) ? query : {};
  if (a === undefined || b === undefined) throw new InvalidRequestError('Name the two Messages to compare with "a" and "b".');
  const [left, right] = [parseHandle(a), parseHandle(b)];
  if (left === right) throw new InvalidRequestError('Compare two different Messages: "a" and "b" are the same handle.');
  const views = await Promise.all([checkouts.message(id, left), checkouts.message(id, right)]);
  return { left: views[0], right: views[1], diff: diffMessages(views[0], views[1]) };
}

export function registerCheckoutRoutes(app: FastifyInstance, deps: CheckoutRouteDeps) {
  const { checkouts, access } = deps;
  // Registered before the routes, so it covers every route under /api/checkouts/:id.
  app.addHook('preHandler', async (req) => {
    const url = req.routeOptions.url;
    if (url !== '/api/checkouts/:id' && !url?.startsWith('/api/checkouts/:id/')) return;
    checkouts.checkOwner((req.params as { id: string }).id, operatorOf(req));
  });

  app.post<{ Params: { profile: string; vhost: string; queue: string }; Body: unknown }>(
    '/api/profiles/:profile/vhosts/:vhost/queues/:queue/checkouts',
    async (req, reply) => {
      const { profile, vhost, queue } = req.params;
      const body = req.body ?? {};
      if (!isRecord(body)) throw new InvalidRequestError('The request body must be a JSON object.');
      const { overrideConsumers = false } = body;
      if (typeof overrideConsumers !== 'boolean') throw new InvalidRequestError('"overrideConsumers" must be true or false.');
      const target = access.queue(operatorOf(req), 'checkout', profile, vhost, queue);
      const auditScope = access.auditScope(operatorOf(req), 'read_audit_entries');
      const checkout = await checkouts.start(target, operatorOf(req), { overrideConsumers, auditScope });
      return reply.status(201).send({ checkout: await checkouts.withRuleBadges(checkout) });
    },
  );

  app.get<{ Params: { id: string } }>('/api/checkouts/:id', async (req) => {
    checkoutAccess(deps, req, 'checkout');
    return { checkout: await checkouts.withRuleBadges(checkouts.get(req.params.id)) };
  });

  app.get<{ Params: { id: string; handle: string } }>('/api/checkouts/:id/messages/:handle', async (req) => {
    const handle = parseHandle(req.params.handle);
    checkoutAccess(deps, req, 'checkout');
    return { message: await checkouts.message(req.params.id, handle) };
  });

  app.get<{ Params: { id: string }; Querystring: unknown }>('/api/checkouts/:id/compare', async (req) => {
    checkoutAccess(deps, req, 'checkout');
    return compareMessages(checkouts, req.params.id, req.query);
  });

  // Only a heartbeat keeps a Checkout alive: reading it does not, so a stray
  // poll cannot keep Messages held after the browser is gone.
  app.post<{ Params: { id: string } }>('/api/checkouts/:id/heartbeat', async (req) => {
    checkoutAccess(deps, req, 'checkout');
    return { checkout: await checkouts.withRuleBadges(checkouts.heartbeat(req.params.id)) };
  });

  const end = async (req: FastifyRequest<{ Params: { id: string } }>) => {
    checkoutAccess(deps, req, 'checkout');
    return { checkout: await checkouts.withRuleBadges(await checkouts.end(req.params.id)) };
  };
  app.delete<{ Params: { id: string } }>('/api/checkouts/:id', end);
  app.post<{ Params: { id: string } }>('/api/checkouts/:id/end', end);
}
