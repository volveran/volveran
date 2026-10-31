// Health routes for Kubernetes probes and Compose health checks. They sit
// outside /api/, so Team Mode's session guard never applies, and they are
// left out of the request log so it shows Operator activity, not probes.
// Neither checks a broker: one unreachable Broker Profile must not take the
// UI away for the others. The body is fixed and reveals nothing.
//
//   GET /healthz → 200 { status: "ok" } whenever the process serves HTTP
//   GET /readyz  → 200 { status: "ok" } once startup has finished,
//                  503 { status: "unavailable" } while the audit store cannot be
//                  reached (only PostgreSQL ever is), and 503 once shutdown starts
//
// A pod that cannot write Audit Entries takes no traffic, and is not restarted:
// it reconnects by itself. The server only listens once startup has finished (server.ts), so no request
// reaches /readyz before then. Once shutdown starts, Fastify answers 503 to
// every request itself (its return503OnClosing default) before any route
// runs, with the fixed body
// {"error":"Service Unavailable","message":"Service Unavailable","statusCode":503}.
import type { FastifyInstance } from 'fastify';
import type { AuditStore } from '../audit/audit-store.js';

export function registerHealthRoutes(app: FastifyInstance, store: Pick<AuditStore, 'ping'>) {
  // Probes are not logged, so say once when the answer changes.
  let reachable = true;
  app.get('/healthz', { logLevel: 'silent' }, async () => ({ status: 'ok' }));
  app.get('/readyz', { logLevel: 'silent' }, async (_req, reply) => {
    try {
      await store.ping();
    } catch (err) {
      if (reachable) app.log.error({ err }, 'The audit store is unreachable: not ready until it is back');
      reachable = false;
      return reply.status(503).send({ status: 'unavailable' });
    }
    if (!reachable) app.log.info('The audit store is reachable again');
    reachable = true;
    return { status: 'ok' };
  });
}
