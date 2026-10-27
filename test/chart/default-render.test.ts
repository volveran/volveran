// The default install: what the chart renders with only the required values,
// and what it never renders.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { chartDir, container, render, repoRoot } from './render.js';

const packageVersion = (JSON.parse(readFileSync(path.join(repoRoot, 'package.json'), 'utf8')) as { version: string })
  .version;
const chartYaml = parse(readFileSync(path.join(chartDir, 'Chart.yaml'), 'utf8')) as {
  name: string;
  version: string;
  appVersion: string;
};

describe('default render', () => {
  it('renders a Deployment, a Service, the Broker Profiles ConfigMap and the audit store PVC, and nothing else', () => {
    expect(render().kinds()).toEqual(['ConfigMap', 'Deployment', 'PersistentVolumeClaim', 'Service']);
  });

  it('renders no route, NetworkPolicy, PodDisruptionBudget, HorizontalPodAutoscaler or Secret', () => {
    const kinds = render().kinds();
    for (const kind of [
      'HTTPRoute',
      'Ingress',
      'NetworkPolicy',
      'PodDisruptionBudget',
      'HorizontalPodAutoscaler',
      'Secret',
    ]) {
      expect(kinds).not.toContain(kind);
    }
  });

  it('versions the chart in lockstep with package.json', () => {
    expect(chartYaml).toMatchObject({ name: 'volveran', version: packageVersion, appVersion: packageVersion });
  });

  it("deploys the image tag matching the chart's appVersion", () => {
    expect(container(render()).image).toBe(`ghcr.io/volveran/volveran:${packageVersion}`);
  });

  it('exposes a ClusterIP Service on a configurable port, sending traffic to the container port 8080', () => {
    const service = render({ service: { port: 80 } }).one('Service');
    expect(service.spec).toMatchObject({ type: 'ClusterIP', ports: [{ port: 80, targetPort: 'http' }] });
    expect(container(render()).ports).toEqual([{ name: 'http', containerPort: 8080, protocol: 'TCP' }]);
    expect(render().one('Service').spec.ports[0].port).toBe(8080);
  });
});
