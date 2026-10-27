// The pod fits a cluster's scheduling rules: node selector, tolerations,
// affinity and priority class reach the pod spec, and pod labels and
// annotations reach the pod template next to the chart's own.
import { describe, expect, it } from 'vitest';
import { podSpec, render, renderRefusal, type Values } from './render.js';

const scheduling = {
  nodeSelector: { 'kubernetes.io/os': 'linux', pool: 'tools' },
  tolerations: [{ key: 'dedicated', operator: 'Equal', value: 'tools', effect: 'NoSchedule' }],
  affinity: {
    nodeAffinity: {
      requiredDuringSchedulingIgnoredDuringExecution: {
        nodeSelectorTerms: [{ matchExpressions: [{ key: 'topology.kubernetes.io/zone', operator: 'In', values: ['a'] }] }],
      },
    },
  },
  priorityClassName: 'ops-tools',
};

describe('pod scheduling', () => {
  it('passes node selector, tolerations, affinity and priority class to the pod', () => {
    expect(podSpec(render({ pod: scheduling }))).toMatchObject(scheduling);
  });

  it('sets none of them by default', () => {
    const spec = podSpec(render());
    for (const field of ['nodeSelector', 'tolerations', 'affinity', 'priorityClassName']) {
      expect(spec[field]).toBeUndefined();
    }
  });
});

describe('pod labels and annotations', () => {
  const template = (values: Values) => render(values).one('Deployment').spec.template.metadata;

  it("adds pod labels next to the chart's selector labels", () => {
    expect(template({ pod: { labels: { team: 'ops', 'cost-center': 'cc-42' } } }).labels).toEqual({
      'app.kubernetes.io/name': 'volveran',
      'app.kubernetes.io/instance': 'volveran',
      team: 'ops',
      'cost-center': 'cc-42',
    });
  });

  it("adds pod annotations next to the chart's profiles checksum", () => {
    const annotations = template({ pod: { annotations: { 'backup.example.com/include': 'true' } } }).annotations;
    expect(annotations['backup.example.com/include']).toBe('true');
    expect(annotations['checksum/broker-profiles']).toMatch(/^[0-9a-f]{64}$/);
  });

  it('adds pod annotations with an existing Broker Profiles ConfigMap too', () => {
    const annotations = template({
      brokerProfiles: { profiles: [], existingConfigMap: 'team-broker-profiles' },
      pod: { annotations: { 'backup.example.com/include': 'true' } },
    }).annotations;
    expect(annotations).toEqual({ 'backup.example.com/include': 'true' });
  });

  it.each([false, true])('refuses a pod label that would change the selector (skip schema: %s)', (skipSchemaValidation) => {
    expect(
      renderRefusal({ pod: { labels: { 'app.kubernetes.io/name': 'other' } } }, { skipSchemaValidation }),
    ).toContain('pod.labels.app.kubernetes.io/name is set by the chart');
  });

  it('refuses a pod annotation that would hide the profiles checksum', () => {
    expect(renderRefusal({ pod: { annotations: { 'checksum/broker-profiles': 'x' } } })).toContain(
      'pod.annotations.checksum/broker-profiles is set by the chart',
    );
  });
});
