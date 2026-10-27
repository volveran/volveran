// Kubelet probes use the health endpoints, which answer without a session and
// never depend on a broker. Volverán listens only after OIDC discovery, so the
// startup probe waits several minutes before liveness takes over.
import { describe, expect, it } from 'vitest';
import { container, render } from './render.js';

describe('probes', () => {
  it('checks liveness on /healthz and readiness on /readyz, over the http port', () => {
    const { livenessProbe, readinessProbe } = container(render());
    expect(livenessProbe.httpGet).toEqual({ path: '/healthz', port: 'http' });
    expect(readinessProbe.httpGet).toEqual({ path: '/readyz', port: 'http' });
  });

  it('gives a slow OIDC provider at least five minutes at startup before the pod is restarted', () => {
    const { startupProbe } = container(render());
    expect(startupProbe.httpGet).toEqual({ path: '/healthz', port: 'http' });
    expect(startupProbe.periodSeconds * startupProbe.failureThreshold).toBeGreaterThanOrEqual(300);
  });

  it('never probes the session-guarded API', () => {
    const probes = container(render());
    for (const probe of [probes.livenessProbe, probes.readinessProbe, probes.startupProbe]) {
      expect(probe.httpGet.path).not.toMatch(/^\/api\//);
    }
  });
});
