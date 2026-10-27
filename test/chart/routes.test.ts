// Exposure: an optional Gateway API HTTPRoute attached to an existing Gateway,
// an optional classic Ingress, or neither (port-forward only). Both route to
// the Service at the root of the host, because the session cookies are scoped
// to / and /auth.
import { describe, expect, it } from 'vitest';
import { render, renderRefusal } from './render.js';

const httpRoute = {
  httpRoute: {
    enabled: true,
    parentRefs: [{ name: 'edge', namespace: 'gateways', sectionName: 'https' }],
    hostnames: ['volveran.example.com'],
  },
};

const ingress = {
  ingress: {
    enabled: true,
    className: 'nginx',
    hosts: ['volveran.example.com'],
    tls: [{ secretName: 'volveran-tls', hosts: ['volveran.example.com'] }],
  },
};

describe('HTTPRoute', () => {
  it('is not rendered by default', () => {
    expect(render().kinds()).not.toContain('HTTPRoute');
  });

  it('attaches to the given Gateway for the given host names', () => {
    const route = render(httpRoute).one('HTTPRoute');
    expect(route.apiVersion).toBe('gateway.networking.k8s.io/v1');
    expect(route.spec.parentRefs).toEqual([{ name: 'edge', namespace: 'gateways', sectionName: 'https' }]);
    expect(route.spec.hostnames).toEqual(['volveran.example.com']);
  });

  it('sends every path of the host to the Service port', () => {
    const chart = render({ ...httpRoute, service: { port: 80 } });
    const service = chart.one('Service').metadata.name;
    expect(chart.one('HTTPRoute').spec.rules).toEqual([
      {
        matches: [{ path: { type: 'PathPrefix', value: '/' } }],
        backendRefs: [{ name: service, port: 80 }],
      },
    ]);
  });

  it('carries the given annotations and the chart labels', () => {
    const route = render({ httpRoute: { ...httpRoute.httpRoute, annotations: { 'example.com/team': 'ops' } } }).one(
      'HTTPRoute',
    );
    expect(route.metadata.annotations).toEqual({ 'example.com/team': 'ops' });
    expect(route.metadata.labels).toMatchObject({ 'app.kubernetes.io/name': 'volveran' });
  });
});

describe('Ingress', () => {
  it('is not rendered by default', () => {
    expect(render().kinds()).not.toContain('Ingress');
  });

  it('uses the given class and routes each host at its root to the Service port', () => {
    const chart = render({ ...ingress, service: { port: 80 } });
    const service = chart.one('Service').metadata.name;
    const spec = chart.one('Ingress').spec;
    expect(chart.one('Ingress').apiVersion).toBe('networking.k8s.io/v1');
    expect(spec.ingressClassName).toBe('nginx');
    expect(spec.rules).toEqual([
      {
        host: 'volveran.example.com',
        http: {
          paths: [{ path: '/', pathType: 'Prefix', backend: { service: { name: service, port: { number: 80 } } } }],
        },
      },
    ]);
  });

  it('terminates TLS with the given Secret names', () => {
    expect(render(ingress).one('Ingress').spec.tls).toEqual([
      { secretName: 'volveran-tls', hosts: ['volveran.example.com'] },
    ]);
  });

  it('leaves the class to the cluster default when none is given, and carries the annotations', () => {
    const route = render({
      ingress: { enabled: true, hosts: ['volveran.example.com'], annotations: { 'example.com/team': 'ops' } },
    }).one('Ingress');
    expect(route.spec.ingressClassName).toBeUndefined();
    expect(route.spec.tls).toBeUndefined();
    expect(route.metadata.annotations).toEqual({ 'example.com/team': 'ops' });
  });
});

describe('both route kinds', () => {
  it('can be enabled together, for example during a migration', () => {
    const chart = render({ ...httpRoute, ...ingress });
    expect(chart.ofKind('HTTPRoute')).toHaveLength(1);
    expect(chart.ofKind('Ingress')).toHaveLength(1);
  });

  it('never come with a Gateway or a cert-manager Certificate', () => {
    const kinds = render({ ...httpRoute, ...ingress }).kinds();
    expect(kinds).not.toContain('Gateway');
    expect(kinds).not.toContain('Certificate');
  });
});

describe.each([
  { schema: 'with the values schema', skipSchemaValidation: false },
  { schema: 'with --skip-schema-validation', skipSchemaValidation: true },
])('route refusals $schema', ({ skipSchemaValidation }) => {
  it('refuses an HTTPRoute without a parent Gateway', () => {
    const values = { httpRoute: { enabled: true, hostnames: ['volveran.example.com'] } };
    expect(renderRefusal(values, { skipSchemaValidation })).toContain(
      'httpRoute.parentRefs must name at least one Gateway',
    );
  });

  it('refuses an HTTPRoute without a host name', () => {
    const values = { httpRoute: { enabled: true, parentRefs: [{ name: 'edge' }] } };
    expect(renderRefusal(values, { skipSchemaValidation })).toContain(
      'httpRoute.hostnames must list at least one host',
    );
  });

  it('refuses an Ingress without a host', () => {
    expect(renderRefusal({ ingress: { enabled: true } }, { skipSchemaValidation })).toContain(
      'ingress.hosts must list at least one host',
    );
  });
});

describe('route values', () => {
  it('have no path prefix: Volverán is always served at the root of its host', () => {
    expect(renderRefusal({ httpRoute: { ...httpRoute.httpRoute, path: '/volveran' } })).toMatch(/path/);
    expect(renderRefusal({ ingress: { ...ingress.ingress, path: '/volveran' } })).toMatch(/path/);
  });
});
