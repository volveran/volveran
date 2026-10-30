// The chart side of metrics: turned on, the pod serves them on a port of its
// own that the Service names and the routes never reference.
import { describe, expect, it } from 'vitest';
import { container, env, render, renderRefusal } from './render.js';

const metrics = { metrics: { enabled: true } };

describe('metrics port', () => {
  it('is absent by default: no variable, no container port, no Service port', () => {
    const chart = render();
    expect(env(chart, 'VOLVERAN_METRICS_PORT')).toBeUndefined();
    expect(container(chart).ports).toEqual([{ name: 'http', containerPort: 8080, protocol: 'TCP' }]);
    expect(chart.one('Service').spec.ports.map((p: { name: string }) => p.name)).toEqual(['http']);
  });

  it('turned on, sets the variable and adds the container port and the Service port at 9464', () => {
    const chart = render(metrics);
    expect(env(chart, 'VOLVERAN_METRICS_PORT')).toEqual({ name: 'VOLVERAN_METRICS_PORT', value: '9464' });
    expect(container(chart).ports).toContainEqual({ name: 'metrics', containerPort: 9464, protocol: 'TCP' });
    expect(chart.one('Service').spec.ports).toContainEqual({
      name: 'metrics',
      port: 9464,
      targetPort: 'metrics',
      protocol: 'TCP',
    });
  });

  it('uses the configured port everywhere', () => {
    const chart = render({ metrics: { enabled: true, port: 9100 } });
    expect(env(chart, 'VOLVERAN_METRICS_PORT').value).toBe('9100');
    expect(container(chart).ports).toContainEqual({ name: 'metrics', containerPort: 9100, protocol: 'TCP' });
    expect(chart.one('Service').spec.ports).toContainEqual(expect.objectContaining({ name: 'metrics', port: 9100 }));
  });

  it('leaves the web app listening on all addresses, which the metrics listener shares', () => {
    expect(env(render(metrics), 'VOLVERAN_HOST').value).toBe('0.0.0.0');
  });

  it('a port number alone does nothing until enabled', () => {
    const chart = render({ metrics: { port: 9100 } });
    expect(env(chart, 'VOLVERAN_METRICS_PORT')).toBeUndefined();
    expect(container(chart).ports).toHaveLength(1);
  });
});

describe('routes', () => {
  it('never send anything to the metrics port', () => {
    const chart = render({
      ...metrics,
      service: { port: 80 },
      httpRoute: { enabled: true, parentRefs: [{ name: 'edge' }], hostnames: ['volveran.example.com'] },
      ingress: { enabled: true, hosts: ['volveran.example.com'] },
    });
    expect(chart.one('HTTPRoute').spec.rules.flatMap((r: any) => r.backendRefs.map((b: any) => b.port))).toEqual([80]);
    expect(
      chart.one('Ingress').spec.rules.flatMap((r: any) => r.http.paths.map((p: any) => p.backend.service.port)),
    ).toEqual([{ number: 80 }]);
  });
});

describe('ServiceMonitor', () => {
  const asked = { metrics: { enabled: true, serviceMonitor: { enabled: true } } };

  it('is not rendered by default, nor with metrics alone', () => {
    expect(render().kinds()).not.toContain('ServiceMonitor');
    expect(render(metrics).kinds()).not.toContain('ServiceMonitor');
  });

  it('scrapes /metrics on the metrics port of the Service of this release', () => {
    const chart = render(asked);
    const monitor = chart.one('ServiceMonitor');
    expect(monitor.apiVersion).toBe('monitoring.coreos.com/v1');
    expect(monitor.spec.endpoints).toEqual([{ port: 'metrics', path: '/metrics' }]);
    expect(monitor.spec.selector).toEqual({
      matchLabels: { 'app.kubernetes.io/name': 'volveran', 'app.kubernetes.io/instance': 'volveran' },
    });
    expect(chart.one('Service').metadata.labels).toMatchObject(monitor.spec.selector.matchLabels);
  });

  it('carries the given labels next to the chart labels, and the interval and scrape timeout', () => {
    const monitor = render({
      metrics: {
        enabled: true,
        serviceMonitor: { enabled: true, labels: { release: 'prometheus' }, interval: '30s', scrapeTimeout: '10s' },
      },
    }).one('ServiceMonitor');
    expect(monitor.metadata.labels).toMatchObject({ release: 'prometheus', 'app.kubernetes.io/name': 'volveran' });
    expect(monitor.spec.endpoints).toEqual([{ port: 'metrics', path: '/metrics', interval: '30s', scrapeTimeout: '10s' }]);
  });

  it('lets a given label replace a chart label rather than render it twice', () => {
    const monitor = render({
      metrics: { enabled: true, serviceMonitor: { enabled: true, labels: { 'app.kubernetes.io/name': 'dlq' } } },
    }).one('ServiceMonitor');
    expect(monitor.metadata.labels!['app.kubernetes.io/name']).toBe('dlq');
    expect(monitor.spec.selector.matchLabels['app.kubernetes.io/name']).toBe('volveran');
  });
});

describe('network policy for the scraper', () => {
  const gateway = { namespaceSelector: { matchLabels: { 'kubernetes.io/metadata.name': 'gateway-system' } } };
  const prometheus = {
    namespaceSelector: { matchLabels: { 'kubernetes.io/metadata.name': 'monitoring' } },
    podSelector: { matchLabels: { 'app.kubernetes.io/name': 'prometheus' } },
  };
  const toHttp = { from: [gateway], ports: [{ port: 'http', protocol: 'TCP' }] };
  const toMetrics = { from: [prometheus], ports: [{ port: 'metrics', protocol: 'TCP' }] };

  it('admits metricsFrom to the metrics port only, and ingressFrom to the http port only', () => {
    const policy = render({
      ...metrics,
      networkPolicy: { enabled: true, ingressFrom: [gateway], metricsFrom: [prometheus] },
    }).one('NetworkPolicy');
    expect(policy.spec.ingress).toEqual([toHttp, toMetrics]);
  });

  it('gives the scraper no access to the http port when no other peer is named', () => {
    const policy = render({ ...metrics, networkPolicy: { enabled: true, metricsFrom: [prometheus] } }).one(
      'NetworkPolicy',
    );
    expect(policy.spec.ingress).toEqual([toMetrics]);
  });

  it('admits nobody to the metrics port when no scraper is named', () => {
    const policy = render({ ...metrics, networkPolicy: { enabled: true, ingressFrom: [gateway] } }).one(
      'NetworkPolicy',
    );
    expect(policy.spec.ingress).toEqual([toHttp]);
    expect(render({ ...metrics, networkPolicy: { enabled: true } }).one('NetworkPolicy').spec.ingress).toEqual([]);
  });

  it('adds no rule for a port that does not exist when metrics are off', () => {
    const policy = render({ networkPolicy: { enabled: true, ingressFrom: [gateway], metricsFrom: [prometheus] } }).one(
      'NetworkPolicy',
    );
    expect(policy.spec.ingress).toEqual([toHttp]);
  });
});

describe('pod security', () => {
  it('stays restricted with metrics on: the port adds no host port and no privileges', () => {
    const on = container(render(metrics));
    expect(on.securityContext).toEqual(container(render()).securityContext);
    expect(on.ports.every((p: object) => !('hostPort' in p))).toBe(true);
  });
});

describe('refusals', () => {
  it.each([
    ['metrics.enabled that is not a boolean', { metrics: { enabled: 'maybe' } }, 'enabled'],
    ['a metrics.port of 0', { metrics: { port: 0 } }, 'port'],
    ['a metrics.port above 65535', { metrics: { port: 65536 } }, 'port'],
    ['a metrics.port that is not a number', { metrics: { port: 'metrics' } }, 'port'],
    ['an unknown metrics key', { metrics: { path: '/m' } }, 'path'],
    ['serviceMonitor.enabled that is not a boolean', { metrics: { serviceMonitor: { enabled: 1 } } }, 'enabled'],
    ['a serviceMonitor label that is not a string', { metrics: { serviceMonitor: { labels: { a: 1 } } } }, 'labels'],
    ['an interval without a unit', { metrics: { serviceMonitor: { interval: '30' } } }, 'interval'],
    ['a scrapeTimeout that is not a duration', { metrics: { serviceMonitor: { scrapeTimeout: 'soon' } } }, 'scrapeTimeout'],
    ['an unknown serviceMonitor key', { metrics: { serviceMonitor: { namespace: 'x' } } }, 'namespace'],
    ['a metricsFrom that is not a list', { networkPolicy: { metricsFrom: {} } }, 'metricsFrom'],
    ['an empty metricsFrom peer, which would admit everyone', { networkPolicy: { metricsFrom: [{}] } }, 'metricsFrom'],
    ['an unknown metricsFrom peer key', { networkPolicy: { metricsFrom: [{ pods: {} }] } }, 'metricsFrom'],
  ])('the schema refuses %s', (_name, values, named) => {
    expect(renderRefusal(values)).toContain(named);
  });

  describe.each([
    { schema: 'with the values schema', skipSchemaValidation: false },
    { schema: 'with --skip-schema-validation', skipSchemaValidation: true },
  ])('$schema', ({ skipSchemaValidation }) => {
    it('refuses a ServiceMonitor with metrics off, which would scrape nothing', () => {
      expect(renderRefusal({ metrics: { serviceMonitor: { enabled: true } } }, { skipSchemaValidation })).toContain(
        'metrics.serviceMonitor.enabled needs metrics.enabled',
      );
    });

    it("refuses the web app's container port, which never serves metrics", () => {
      expect(renderRefusal({ metrics: { enabled: true, port: 8080 } }, { skipSchemaValidation })).toContain(
        'metrics.port must differ from 8080',
      );
    });

    it('refuses the port of the Service, which cannot carry both', () => {
      expect(
        renderRefusal({ metrics: { enabled: true, port: 9000 }, service: { port: 9000 } }, { skipSchemaValidation }),
      ).toContain('metrics.port must differ from service.port');
    });

    it('refuses VOLVERAN_METRICS_PORT in extraEnv, which would open a port the chart does not know about', () => {
      expect(
        renderRefusal({ extraEnv: [{ name: 'VOLVERAN_METRICS_PORT', value: '9464' }] }, { skipSchemaValidation }),
      ).toContain('extraEnv sets VOLVERAN_METRICS_PORT: use metrics.enabled and metrics.port instead');
    });
  });

  it('ignores the port checks while metrics are off', () => {
    expect(render({ metrics: { port: 8080 } }).kinds()).toContain('Deployment');
  });
});
