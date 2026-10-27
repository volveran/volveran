// Health routes for Kubernetes probes and Compose health checks. They sit
// outside /api/, so Team Mode's session guard never applies, and they are
// left out of the request log so it shows Operator activity, not probes.
// Neither checks a broker: one unreachable Broker Profile must not take the
// UI away for the others. The body is fixed and reveals nothing.
//
//   GET /healthz → 200 { status: "ok" } whenever the process serves HTTP
//   GET /readyz  → 200 { status: "ok" } once startup has finished,
//                  503 { status: "starting" } before (and while shutting down)
import type { FastifyInstance } from 'fastify';

export interface HealthRouteDeps {
  /** True once configuration, Broker Profiles, OIDC discovery and the audit store are ready. */
  isReady: () => boolean;
}

export function registerHealthRoutes(app: FastifyInstance, { isReady }: HealthRouteDeps) {
  app.get('/healthz', { logLevel: 'silent' }, async () => ({ status: 'ok' }));
  app.get('/readyz', { logLevel: 'silent' }, async (_req, reply) => {
    if (isReady()) return { status: 'ok' };
    return reply.status(503).send({ status: 'starting' });
  });
}
