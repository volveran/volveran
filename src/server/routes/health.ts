// Health routes for Kubernetes probes and Compose health checks. They sit
// outside /api/, so Team Mode's session guard never applies, and they are
// left out of the request log so it shows Operator activity, not probes.
// Neither checks a broker: one unreachable Broker Profile must not take the
// UI away for the others. The body is fixed and reveals nothing.
//
//   GET /healthz → 200 { status: "ok" } whenever the process serves HTTP
//   GET /readyz  → 200 { status: "ok" } once startup has finished,
//                  503 { status: "unavailable" } while the audit store cannot be
//                  reached, and from the moment shutdown starts
//
// A Replica that cannot write Audit Entries takes no traffic, and is not restarted:
// it reconnects by itself. The server only listens once startup has finished (server.ts), so no request
// reaches /readyz before then. Shutdown (server.ts) goes on serving while Checkouts end, so
// /healthz stays 200 and nothing restarts the process meanwhile. Only at the very end, as the
// port closes, does Fastify answer 503 to every request itself (its return503OnClosing default).
import type { FastifyInstance } from 'fastify';
import type { AuditStore } from '../audit/audit-store.js';

export function registerHealthRoutes(app: FastifyInstance, store: Pick<AuditStore, 'ping'>, shuttingDown: () => boolean) {
  // Probes are not logged, so say once when the answer changes.
  let reachable = true;
  app.get('/healthz', { logLevel: 'silent' }, async () => ({ status: 'ok' }));
  app.get('/readyz', { logLevel: 'silent' }, async (_req, reply) => {
    if (shuttingDown()) return reply.status(503).send({ status: 'unavailable' });
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
