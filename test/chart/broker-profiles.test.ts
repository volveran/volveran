// Inline Broker Profiles become profiles.yaml in a chart-managed ConfigMap,
// mounted where the image reads it, and a change to them rolls the pod.
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { env, render, volumeAt, type Rendered } from './render.js';

const prod = {
  name: 'prod',
  managementUrl: 'https://rabbit.example.com:15671',
  amqpUrl: 'amqps://rabbit.example.com:5671',
  username: 'volveran',
  passwordEnv: 'VOLVERAN_PROD_PASSWORD',
  vhosts: ['/'],
  defaultQueueFilter: '*.dlq',
  protected: true,
};

/** The pod template's annotations: Kubernetes rolls the pod when they change. */
const podAnnotations = (chart: Rendered) => chart.one('Deployment').spec.template.metadata.annotations ?? {};

describe('Broker Profiles', () => {
  it('renders the inline profiles as profiles.yaml, in the same shape as the profiles YAML', () => {
    const configMap = render().one('ConfigMap');
    expect(parse(configMap.data!['profiles.yaml']!)).toEqual({ profiles: [prod] });
  });

  it('mounts profiles.yaml read-only where Volverán reads it', () => {
    const chart = render();
    expect(env(chart, 'VOLVERAN_PROFILES_FILE').value).toBe('/config/profiles.yaml');
    const { mount, volume } = volumeAt(chart, '/config');
    expect(mount.readOnly).toBe(true);
    expect(volume.configMap.name).toBe(chart.one('ConfigMap').metadata.name);
  });

  it('changes the pod template annotations when a profile changes, so the pod rolls', () => {
    const before = podAnnotations(render());
    const after = podAnnotations(
      render({ brokerProfiles: { profiles: [{ ...prod, defaultQueueFilter: '*.dead' }] } }),
    );
    expect(after).not.toEqual(before);
  });

  it('keeps the pod template annotations when nothing about the profiles changes', () => {
    expect(podAnnotations(render({ service: { port: 80 } }))).toEqual(podAnnotations(render()));
  });
});

describe('Broker Profiles from an existing ConfigMap', () => {
  const existing = { brokerProfiles: { profiles: [], existingConfigMap: 'team-broker-profiles' } };

  it('mounts the existing ConfigMap at /config instead of rendering one', () => {
    const chart = render(existing);
    expect(chart.ofKind('ConfigMap')).toEqual([]);
    const { mount, volume } = volumeAt(chart, '/config');
    expect(mount.readOnly).toBe(true);
    expect(volume.configMap.name).toBe('team-broker-profiles');
    expect(env(chart, 'VOLVERAN_PROFILES_FILE').value).toBe('/config/profiles.yaml');
  });

  it('puts nothing about that ConfigMap in the pod template annotations, since the chart cannot see its content', () => {
    const renamed = { brokerProfiles: { profiles: [], existingConfigMap: 'team-broker-profiles-v2' } };
    expect(podAnnotations(render(renamed))).toEqual(podAnnotations(render(existing)));
  });
});
