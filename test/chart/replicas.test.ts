// Several Replicas (ADR 0014): only on PostgreSQL, rolling, with no volume, spread over nodes,
// and an internal port that only other Replicas can reach, whatever networkPolicy says.
import { describe, expect, it } from 'vitest';
import { container, env, podSpec, render, renderNotes, renderRefusal, volumeAt, type Values } from './render.js';

const several = (values: Values = {}) => render(values, { fixture: 'replicas' });

describe.each([false, true])('refusals (skip schema: %s)', (skipSchemaValidation) => {
  const refusal = (values: Values, fixture: string | null = 'replicas') => renderRefusal(values, { fixture, skipSchemaValidation });

  it('refuses several Replicas on SQLite, citing ADR 0014', () => {
    const message = refusal({ replicaCount: 2 }, 'team');
    expect(message).toContain('replicaCount above 1 needs postgres.existingSecret');
    expect(message).toContain('docs/adr/0014-replicas-forwarding-and-the-background-leader.md');
  });

  it('refuses several Replicas without the forwarding secret', () => {
    expect(refusal({ forwarding: { existingSecret: '' } })).toContain('replicaCount above 1 needs forwarding.existingSecret');
  });

  it.each([0, -1])('refuses replicaCount: %i', (replicaCount) => {
    expect(refusal({ replicaCount })).toContain('replicaCount');
  });

  it('refuses a forwarding port that is the web port', () => {
    expect(refusal({ forwarding: { port: 8080 } })).toContain('forwarding.port must differ from 8080');
  });

  it('refuses a forwarding port that is the metrics port', () => {
    expect(refusal({ metrics: { enabled: true, port: 9000 }, forwarding: { port: 9000 } })).toContain('forwarding.port must differ from metrics.port');
  });

  // Through extraEnv these would open the port with nothing guarding it.
  it.each(['VOLVERAN_FORWARDING_SECRET', 'VOLVERAN_FORWARDING_PORT', 'VOLVERAN_FORWARDING_ADDRESS'])('refuses %s in extraEnv, on one Replica too', (name) => {
    expect(refusal({ extraEnv: [{ name, value: 'x' }] }, 'team')).toContain(`extraEnv sets ${name}`);
    expect(refusal({ extraEnv: [{ name, value: 'x' }] })).toContain(`extraEnv sets ${name}`);
  });
});

describe('several Replicas', () => {
  it('runs them with a rolling update that keeps every Replica serving until its replacement is ready', () => {
    const { spec } = several({ replicaCount: 3 }).one('Deployment');
    expect(spec.replicas).toBe(3);
    expect(spec.strategy).toEqual({ type: 'RollingUpdate', rollingUpdate: { maxSurge: 1, maxUnavailable: 0 } });
  });

  it('has no claim and no data volume', () => {
    const chart = several();
    expect(chart.ofKind('PersistentVolumeClaim')).toEqual([]);
    expect(volumeAt(chart, '/data').mount).toBeUndefined();
  });

  it('lets a drain take one pod at a time', () => {
    const budget = several().one('PodDisruptionBudget');
    expect(budget.apiVersion).toBe('policy/v1');
    expect(budget.spec).toEqual({
      maxUnavailable: 1,
      selector: { matchLabels: { 'app.kubernetes.io/name': 'volveran', 'app.kubernetes.io/instance': 'volveran' } },
    });
  });

  it('spreads the pods over nodes and zones, without refusing to schedule on a small cluster', () => {
    const labelSelector = { matchLabels: { 'app.kubernetes.io/name': 'volveran', 'app.kubernetes.io/instance': 'volveran' } };
    expect(podSpec(several()).topologySpreadConstraints).toEqual([
      { maxSkew: 1, topologyKey: 'kubernetes.io/hostname', whenUnsatisfiable: 'ScheduleAnyway', labelSelector },
      { maxSkew: 1, topologyKey: 'topology.kubernetes.io/zone', whenUnsatisfiable: 'ScheduleAnyway', labelSelector },
    ]);
  });

  it('takes other spread constraints from values', () => {
    const own = [{ maxSkew: 1, topologyKey: 'kubernetes.io/hostname', whenUnsatisfiable: 'DoNotSchedule', labelSelector: { matchLabels: { a: 'b' } } }];
    expect(podSpec(several({ pod: { topologySpreadConstraints: own } })).topologySpreadConstraints).toEqual(own);
  });

  it('gives each Replica the internal port, the secret, and its own pod address', () => {
    const chart = several();
    expect(container(chart).ports).toContainEqual({ name: 'forwarding', containerPort: 8081, protocol: 'TCP' });
    expect(env(chart, 'VOLVERAN_FORWARDING_SECRET')).toEqual({
      name: 'VOLVERAN_FORWARDING_SECRET',
      valueFrom: { secretKeyRef: { name: 'volveran-forwarding', key: 'forwarding-secret' } },
    });
    expect(env(chart, 'VOLVERAN_FORWARDING_PORT').value).toBe('8081');
    expect(env(chart, 'VOLVERAN_POD_IP').valueFrom).toEqual({ fieldRef: { fieldPath: 'status.podIP' } });
    expect(env(chart, 'VOLVERAN_FORWARDING_ADDRESS').value).toBe('$(VOLVERAN_POD_IP):8081');
    // Kubernetes expands $(VAR) only from variables defined earlier in the list.
    const names = container(chart).env.map((e: { name: string }) => e.name);
    expect(names.indexOf('VOLVERAN_POD_IP')).toBeLessThan(names.indexOf('VOLVERAN_FORWARDING_ADDRESS'));
  });

  it('takes another port and key', () => {
    const chart = several({ forwarding: { port: 9001, secretKey: 'shared' } });
    expect(container(chart).ports).toContainEqual({ name: 'forwarding', containerPort: 9001, protocol: 'TCP' });
    expect(env(chart, 'VOLVERAN_FORWARDING_PORT').value).toBe('9001');
    expect(env(chart, 'VOLVERAN_FORWARDING_ADDRESS').value).toBe('$(VOLVERAN_POD_IP):9001');
    expect(env(chart, 'VOLVERAN_FORWARDING_SECRET').valueFrom.secretKeyRef.key).toBe('shared');
  });

  it('never makes liveness depend on /readyz, which fails at once on shutdown', () => {
    expect(container(several()).livenessProbe.httpGet.path).toBe('/healthz');
  });

  it('adds a headless Service with only the internal port, and no route to it', () => {
    const chart = render({ httpRoute: { enabled: true, parentRefs: [{ name: 'edge' }], hostnames: ['volveran.example.com'] } }, { fixture: 'replicas' });
    const [main, headless] = [chart.ofKind('Service').find((s) => s.metadata.name === 'volveran')!, chart.ofKind('Service').find((s) => s.metadata.name === 'volveran-replicas')!];
    expect(headless.spec.clusterIP).toBe('None');
    expect(headless.spec.ports).toEqual([{ name: 'forwarding', port: 8081, targetPort: 'forwarding', protocol: 'TCP' }]);
    expect(main.spec.ports.map((p: { name: string }) => p.name)).toEqual(['http']);
    const backends = chart.one('HTTPRoute').spec.rules.flatMap((r: any) => r.backendRefs);
    expect(backends.map((b: any) => [b.name, b.port])).toEqual([['volveran', 8080]]);
  });

  it("leaves Prometheus every pod's own target, through the main Service's metrics port", () => {
    const chart = several({ metrics: { enabled: true, serviceMonitor: { enabled: true } } });
    const { endpoints } = chart.one('ServiceMonitor').spec;
    expect(endpoints).toEqual([{ port: 'metrics', path: '/metrics' }]);
    const withMetrics = chart.ofKind('Service').filter((s) => s.spec.ports.some((p: { name: string }) => p.name === 'metrics'));
    expect(withMetrics.map((s) => s.metadata.name)).toEqual(['volveran']);
  });

  it('says so in the install notes', () => {
    const notes = renderNotes({}, { fixture: 'replicas' });
    expect(notes).toContain('2 Replicas');
    expect(notes).not.toContain('one replica');
    expect(notes).not.toContain('signs every Operator out');
  });
});

describe('the forwarding port', () => {
  const selector = { matchLabels: { 'app.kubernetes.io/name': 'volveran', 'app.kubernetes.io/instance': 'volveran' } };
  const replicasOnly = { from: [{ podSelector: selector }], ports: [{ port: 'forwarding', protocol: 'TCP' }] };
  const gateway = { namespaceSelector: { matchLabels: { 'kubernetes.io/metadata.name': 'gateways' } } };
  const scraper = { podSelector: { matchLabels: { app: 'prometheus' } } };

  it('is closed by default: a policy admits only other Replicas to it, and leaves the web port as it is with no policy', () => {
    const policy = several().one('NetworkPolicy');
    expect(policy.spec.podSelector).toEqual(selector);
    expect(policy.spec.policyTypes).toEqual(['Ingress']);
    expect(policy.spec.ingress).toEqual([{ ports: [{ port: 'http', protocol: 'TCP' }] }, replicasOnly]);
  });

  it('leaves the metrics port open too when no policy was asked for, as on one Replica', () => {
    const policy = several({ metrics: { enabled: true } }).one('NetworkPolicy');
    expect(policy.spec.ingress).toEqual([{ ports: [{ port: 'http', protocol: 'TCP' }, { port: 'metrics', protocol: 'TCP' }] }, replicasOnly]);
  });

  it('is closed the same way under a policy that was asked for, which still limits the other ports', () => {
    const policy = several({ metrics: { enabled: true }, networkPolicy: { enabled: true, ingressFrom: [gateway], metricsFrom: [scraper] } }).one('NetworkPolicy');
    expect(policy.spec.ingress).toEqual([
      { from: [gateway], ports: [{ port: 'http', protocol: 'TCP' }] },
      { from: [scraper], ports: [{ port: 'metrics', protocol: 'TCP' }] },
      replicasOnly,
    ]);
  });

  it('still admits Replicas when the policy names no other peer', () => {
    expect(several({ networkPolicy: { enabled: true } }).one('NetworkPolicy').spec.ingress).toEqual([replicasOnly]);
  });

  it('can be reached by the others when egress is restricted', () => {
    const broker = { to: [{ ipBlock: { cidr: '10.20.0.0/24' } }], ports: [{ port: 5671, protocol: 'TCP' }] };
    const policy = several({ forwarding: { port: 9001 }, networkPolicy: { enabled: true, egress: [broker] } }).one('NetworkPolicy');
    expect(policy.spec.policyTypes).toEqual(['Ingress', 'Egress']);
    expect(policy.spec.egress).toContainEqual({ to: [{ podSelector: selector }], ports: [{ port: 9001, protocol: 'TCP' }] });
    expect(policy.spec.egress).toContainEqual(broker);
    expect(policy.spec.egress.at(-1).ports).toContainEqual({ port: 53, protocol: 'UDP' });
  });

  it('restricts no egress when no policy was asked for', () => {
    const broker = { to: [{ ipBlock: { cidr: '10.20.0.0/24' } }], ports: [{ port: 5671, protocol: 'TCP' }] };
    const { spec } = several({ networkPolicy: { egress: [broker] } }).one('NetworkPolicy');
    expect(spec.policyTypes).toEqual(['Ingress']);
    expect(spec.egress).toBeUndefined();
  });
});

describe('one Replica', () => {
  it.each(['team', 'postgres'])('has no internal port, secret, budget or spread, on the %s fixture, even with the forwarding values set', (fixture) => {
    const chart = render({ forwarding: { existingSecret: 'unused', port: 9001 } }, { fixture });
    expect(container(chart).ports.map((p: { name: string }) => p.name)).toEqual(['http']);
    expect(env(chart, 'VOLVERAN_FORWARDING_SECRET')).toBeUndefined();
    expect(env(chart, 'VOLVERAN_POD_IP')).toBeUndefined();
    expect(chart.ofKind('PodDisruptionBudget')).toEqual([]);
    expect(chart.ofKind('Service').map((s) => s.metadata.name)).toEqual(['volveran']);
    expect(podSpec(chart).topologySpreadConstraints).toBeUndefined();
    expect(chart.ofKind('NetworkPolicy')).toEqual([]);
  });

  it('takes spread constraints from values', () => {
    const own = [{ maxSkew: 1, topologyKey: 'kubernetes.io/hostname', whenUnsatisfiable: 'ScheduleAnyway' }];
    expect(podSpec(render({ pod: { topologySpreadConstraints: own } })).topologySpreadConstraints).toEqual(own);
  });

  it('keeps its wording in the install notes', () => {
    const notes = renderNotes();
    expect(notes).toContain('one replica');
    expect(notes).toContain('signs every Operator out');
  });
});
