// Health routes for Kubernetes probes and Compose health checks. They sit
// outside /api/, so Team Mode's session guard never applies, and they are
// left out of the request log so it shows Operator activity, not probes.
// Neither checks a broker: one unreachable Broker Profile must not take the
// UI away for the others. The body is fixed and reveals nothing.
//
//   GET /healthz → 200 { status: "ok" } whenever the process serves HTTP
//   GET /readyz  → 200 { status: "ok" } once startup has finished,
//                  503 once shutdown starts
//
// Both routes answer the same way; they differ in how probes use them. The
// server only listens once startup has finished (server.ts), so no request
// reaches /readyz before then. Once shutdown starts, Fastify answers 503 to
// every request itself (its return503OnClosing default) before any route
// runs, with the fixed body
// {"error":"Service Unavailable","message":"Service Unavailable","statusCode":503}.
import type { FastifyInstance } from 'fastify';

export function registerHealthRoutes(app: FastifyInstance) {
  app.get('/healthz', { logLevel: 'silent' }, async () => ({ status: 'ok' }));
  app.get('/readyz', { logLevel: 'silent' }, async () => ({ status: 'ok' }));
}
