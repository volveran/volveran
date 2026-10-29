// Inline Broker Profiles become profiles.yaml in a chart-managed ConfigMap,
// mounted where the image reads it, and a change to them rolls the pod.
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { env, render, renderRefusal, volumeAt, type Rendered } from './render.js';

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

  it('accepts roles, and writes them into profiles.yaml', () => {
    const roles = { viewer: ['support'], operator: ['oncall', 'sre'], admin: ['platform'] };
    const configMap = render({ brokerProfiles: { profiles: [{ ...prod, roles }] } }).one('ConfigMap');
    expect(parse(configMap.data!['profiles.yaml']!)).toEqual({ profiles: [{ ...prod, roles }] });
  });

  it('accepts requireApproval, and writes it into profiles.yaml', () => {
    const configMap = render({ brokerProfiles: { profiles: [{ ...prod, requireApproval: false }] } }).one('ConfigMap');
    expect(parse(configMap.data!['profiles.yaml']!)).toEqual({ profiles: [{ ...prod, requireApproval: false }] });
    expect(renderRefusal({ brokerProfiles: { profiles: [{ ...prod, requireApproval: 'sometimes' }] } })).toMatch(/requireApproval/);
  });

  it('accepts replayRate, writes it into profiles.yaml, and refuses a rate that is not a number', () => {
    const replayRate = { default: 5, max: 50 };
    const configMap = render({ brokerProfiles: { profiles: [{ ...prod, replayRate }] } }).one('ConfigMap');
    expect(parse(configMap.data!['profiles.yaml']!)).toEqual({ profiles: [{ ...prod, replayRate }] });
    expect(renderRefusal({ brokerProfiles: { profiles: [{ ...prod, replayRate: { max: 'fast' } }] } })).toMatch(/replayRate/);
    expect(renderRefusal({ brokerProfiles: { profiles: [{ ...prod, replayRate: { min: 1 } }] } })).toMatch(/replayRate/);
  });

  it('accepts replayRules, writes them into profiles.yaml, and refuses a rule without stopWhen or with an unknown whenAttemptsUsedUp', () => {
    const rule = {
      name: 'db-timeouts',
      vhost: '/',
      queue: 'orders.dlq',
      filter: { kind: 'x-death-reason', value: 'rejected' },
      every: '5m',
      maxPerPass: 50,
      rate: 5,
      backoff: { initial: '1m', multiplier: 2, max: '1h' },
      maxAttempts: 5,
      whenAttemptsUsedUp: { moveTo: { queue: 'orders.parked' } },
      stopWhen: { diedAgain: 10, within: '15m' },
      startPaused: true,
    };
    const configMap = render({ brokerProfiles: { profiles: [{ ...prod, replayRules: [rule] }] } }).one('ConfigMap');
    expect(parse(configMap.data!['profiles.yaml']!)).toEqual({ profiles: [{ ...prod, replayRules: [rule] }] });
    const keep = { ...rule, whenAttemptsUsedUp: 'keep' };
    expect(() => render({ brokerProfiles: { profiles: [{ ...prod, replayRules: [keep] }] } })).not.toThrow();

    const { stopWhen: _s, ...noStop } = rule;
    expect(renderRefusal({ brokerProfiles: { profiles: [{ ...prod, replayRules: [noStop] }] } })).toMatch(/stopWhen/);
    const discard = { ...rule, whenAttemptsUsedUp: 'discard' };
    expect(renderRefusal({ brokerProfiles: { profiles: [{ ...prod, replayRules: [discard] }] } })).toMatch(/whenAttemptsUsedUp/);
  });

  it("accepts credentials: operatorToken with tokenUsernameClaim and no username or passwordEnv, and writes them into profiles.yaml", () => {
    const { username: _u, passwordEnv: _p, ...rest } = prod;
    const tokenProfile = { ...rest, credentials: 'operatorToken', tokenUsernameClaim: 'preferred_username' };
    const configMap = render({ brokerProfiles: { profiles: [tokenProfile] } }).one('ConfigMap');
    expect(parse(configMap.data!['profiles.yaml']!)).toEqual({ profiles: [tokenProfile] });
    expect(parse(render({ brokerProfiles: { profiles: [{ ...prod, credentials: 'shared' }] } }).one('ConfigMap').data!['profiles.yaml']!))
      .toEqual({ profiles: [{ ...prod, credentials: 'shared' }] });
  });

  it('refuses an unknown credentials value, and a shared profile without username or passwordEnv', () => {
    expect(renderRefusal({ brokerProfiles: { profiles: [{ ...prod, credentials: 'oauth' }] } })).toMatch(/credentials/);
    const { username: _u, ...noUsername } = prod;
    expect(renderRefusal({ brokerProfiles: { profiles: [noUsername] } })).toMatch(/username/);
    expect(renderRefusal({ brokerProfiles: { profiles: [{ ...prod, credentials: 'operatorToken' }] } })).toMatch(/brokerProfiles/);
    expect(renderRefusal({ brokerProfiles: { profiles: [{ ...prod, tokenUsernameClaim: 'sub' }] } })).toMatch(/brokerProfiles/);
  });

  it('refuses an unknown role name, or an empty group list', () => {
    expect(renderRefusal({ brokerProfiles: { profiles: [{ ...prod, roles: { owner: ['platform'] } }] } })).toMatch(/roles/);
    expect(renderRefusal({ brokerProfiles: { profiles: [{ ...prod, roles: { admin: [] } }] } })).toMatch(/admin/);
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
