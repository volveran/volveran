// Inline Broker Profiles become profiles.yaml in a chart-managed ConfigMap,
// mounted where the image reads it, and a change to them rolls the pod.
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { container, env, podSpec, render, type Rendered } from './render.js';

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

const checksum = (chart: Rendered) =>
  chart.one('Deployment').spec.template.metadata.annotations['checksum/broker-profiles'];

describe('Broker Profiles', () => {
  it('renders the inline profiles as profiles.yaml, in the same shape as the profiles YAML', () => {
    const configMap = render().one('ConfigMap');
    expect(parse(configMap.data!['profiles.yaml']!)).toEqual({ profiles: [prod] });
  });

  it('mounts profiles.yaml read-only where Volverán reads it', () => {
    const chart = render();
    expect(env(chart, 'VOLVERAN_PROFILES_FILE').value).toBe('/config/profiles.yaml');
    const mount = container(chart).volumeMounts.find((m: { mountPath: string }) => m.mountPath === '/config');
    expect(mount.readOnly).toBe(true);
    const volume = podSpec(chart).volumes.find((v: { name: string }) => v.name === mount.name);
    expect(volume.configMap.name).toBe(chart.one('ConfigMap').metadata.name);
  });

  it('changes the pod checksum annotation when a profile changes, so the pod rolls', () => {
    const before = checksum(render());
    const after = checksum(
      render({ brokerProfiles: { profiles: [{ ...prod, defaultQueueFilter: '*.dead' }] } }),
    );
    expect(before).toMatch(/^[0-9a-f]{64}$/);
    expect(after).toMatch(/^[0-9a-f]{64}$/);
    expect(after).not.toBe(before);
  });

  it('keeps the checksum when nothing about the profiles changes', () => {
    expect(checksum(render({ service: { port: 80 } }))).toBe(checksum(render()));
  });
});
