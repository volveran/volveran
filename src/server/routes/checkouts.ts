// Checkout routes: start a Checkout on a queue, read it and its Messages, end it.
//
//   POST   /api/profiles/:profile/vhosts/:vhost/queues/:queue/checkouts  → 201 { checkout }
//          body { overrideConsumers?: boolean }: start even though other consumers read the queue
//   GET    /api/checkouts/:id                                            → { checkout }
//   GET    /api/checkouts/:id/messages/:handle                           → { message }
//   POST   /api/checkouts/:id/heartbeat  the browser still shows it        → { checkout }
//   DELETE /api/checkouts/:id                                            → { checkout }
//   POST   /api/checkouts/:id/end   same as DELETE, for navigator.sendBeacon
//
// Every /api/checkouts/:id… route (these and routes/decisions.ts) is for the
// Checkout's owner only: another Operator gets 403 `not_checkout_owner`
// before the handler runs, so nothing of the Checkout leaks. In Solo Mode
// there is only one Operator.
import type { FastifyInstance } from 'fastify';
import type { CheckoutManager } from '../checkout/manager.js';
import { CheckoutError } from '../checkout/errors.js';
import { InvalidRequestError } from '../http-error.js';
import { isRecord } from '../is-record.js';
import { operatorOf } from '../operator.js';
import type { QueueRef } from '../profiles.js';

export interface CheckoutRouteDeps {
  checkouts: CheckoutManager;
  /** The queue a request names, after checking its profile and vhost exist (throws an HttpError). */
  queueRef(profile: string, vhost: string, queue: string): QueueRef;
}

export function registerCheckoutRoutes(app: FastifyInstance, { checkouts, queueRef }: CheckoutRouteDeps) {
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
      const checkout = await checkouts.start(queueRef(profile, vhost, queue), operatorOf(req), { overrideConsumers });
      return reply.status(201).send({ checkout });
    },
  );

  app.get<{ Params: { id: string } }>('/api/checkouts/:id', async (req) => ({ checkout: checkouts.get(req.params.id) }));

  app.get<{ Params: { id: string; handle: string } }>('/api/checkouts/:id/messages/:handle', async (req) => {
    const handle = Number(req.params.handle);
    if (!Number.isSafeInteger(handle)) {
      throw new CheckoutError('message_not_found', `"${req.params.handle}" is not a Message handle.`);
    }
    return { message: checkouts.message(req.params.id, handle) };
  });

  // Only a heartbeat keeps a Checkout alive: reading it does not, so a stray
  // poll cannot keep Messages held after the browser is gone.
  app.post<{ Params: { id: string } }>('/api/checkouts/:id/heartbeat', async (req) => ({
    checkout: checkouts.heartbeat(req.params.id),
  }));

  app.delete<{ Params: { id: string } }>('/api/checkouts/:id', async (req) => ({
    checkout: await checkouts.end(req.params.id),
  }));
  app.post<{ Params: { id: string } }>('/api/checkouts/:id/end', async (req) => ({
    checkout: await checkouts.end(req.params.id),
  }));
}
