// The optional NetworkPolicy: it admits only the peers the user names, and
// restricts egress only when the user supplies egress rules, always keeping
// DNS to the cluster resolver open then.
import { describe, expect, it } from 'vitest';
import { render } from './render.js';

const gateway = {
  namespaceSelector: { matchLabels: { 'kubernetes.io/metadata.name': 'gateway-system' } },
  podSelector: { matchLabels: { 'app.kubernetes.io/name': 'envoy' } },
};
const broker = {
  to: [{ ipBlock: { cidr: '10.20.0.0/24' } }],
  ports: [
    { port: 5671, protocol: 'TCP' },
    { port: 15671, protocol: 'TCP' },
  ],
};
const oidc = { to: [{ ipBlock: { cidr: '203.0.113.10/32' } }], ports: [{ port: 443, protocol: 'TCP' }] };

describe('network policy', () => {
  it('is ingress-only when no egress rules are given', () => {
    const policy = render({ networkPolicy: { enabled: true, ingressFrom: [gateway] } }).one('NetworkPolicy');
    expect(policy.spec.policyTypes).toEqual(['Ingress']);
    expect(policy.spec.egress).toBeUndefined();
    expect(policy.spec.ingress).toEqual([{ from: [gateway], ports: [{ port: 'http', protocol: 'TCP' }] }]);
  });

  it('admits no peer at all when none are named, rather than an empty "from" that admits every source', () => {
    const policy = render({ networkPolicy: { enabled: true } }).one('NetworkPolicy');
    expect(policy.spec.policyTypes).toEqual(['Ingress']);
    expect(policy.spec.ingress).toEqual([]);
  });

  it('with egress rules, allows those rules plus DNS to the cluster resolver', () => {
    const policy = render({ networkPolicy: { enabled: true, ingressFrom: [gateway], egress: [broker, oidc] } }).one(
      'NetworkPolicy',
    );
    expect(policy.spec.policyTypes).toEqual(['Ingress', 'Egress']);
    expect(policy.spec.egress).toEqual([
      broker,
      oidc,
      {
        to: [
          {
            namespaceSelector: { matchLabels: { 'kubernetes.io/metadata.name': 'kube-system' } },
            podSelector: { matchLabels: { 'k8s-app': 'kube-dns' } },
          },
        ],
        ports: [
          { port: 53, protocol: 'UDP' },
          { port: 53, protocol: 'TCP' },
        ],
      },
    ]);
  });

  it('sends DNS to the resolver named in values, for clusters whose DNS pods are labelled differently', () => {
    const nodeLocalDns = { ipBlock: { cidr: '169.254.20.10/32' } };
    const policy = render({ networkPolicy: { enabled: true, egress: [broker], dnsTo: [nodeLocalDns] } }).one(
      'NetworkPolicy',
    );
    expect(policy.spec.egress.at(-1).to).toEqual([nodeLocalDns]);
  });

  it('selects only the Volverán pod of this release', () => {
    const chart = render({ networkPolicy: { enabled: true, ingressFrom: [gateway] } });
    const policy = chart.one('NetworkPolicy');
    expect(policy.spec.podSelector).toEqual({
      matchLabels: { 'app.kubernetes.io/name': 'volveran', 'app.kubernetes.io/instance': 'volveran' },
    });
    expect(chart.one('Deployment').spec.template.metadata.labels).toMatchObject(policy.spec.podSelector.matchLabels);
  });

  it('is not rendered unless enabled', () => {
    expect(render({ networkPolicy: { ingressFrom: [gateway], egress: [broker] } }).kinds()).not.toContain(
      'NetworkPolicy',
    );
  });
});
