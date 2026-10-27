// Private CAs: ConfigMaps or Secrets mounted read-only under /etc/volveran/ca,
// so a Broker Profile's absolute caFile can trust an internal broker, and one
// bundle named as the OIDC trust bundle feeds NODE_EXTRA_CA_CERTS, so the
// discovery document of an internal OIDC provider can be read.
import { describe, expect, it } from 'vitest';
import { container, env, render, renderRefusal, volumeAt } from './render.js';

const bundles = [
  { name: 'broker-ca', configMap: 'rabbit-internal-ca' },
  { name: 'corporate-ca', secret: 'corporate-root-ca' },
];

describe('CA bundles', () => {
  it('mounts each ConfigMap or Secret read-only under /etc/volveran/ca/<name>', () => {
    const chart = render({ caBundles: { bundles } });
    const broker = volumeAt(chart, '/etc/volveran/ca/broker-ca');
    expect(broker.mount.readOnly).toBe(true);
    expect(broker.volume.configMap).toEqual({ name: 'rabbit-internal-ca' });
    const corporate = volumeAt(chart, '/etc/volveran/ca/corporate-ca');
    expect(corporate.mount.readOnly).toBe(true);
    expect(corporate.volume.secret).toEqual({ secretName: 'corporate-root-ca' });
  });

  it('lets a Broker Profile reference a mounted bundle by absolute caFile', () => {
    const profile = {
      name: 'internal',
      managementUrl: 'https://rabbit.internal.example.com:15671',
      amqpUrl: 'amqps://rabbit.internal.example.com:5671',
      caFile: '/etc/volveran/ca/broker-ca/ca.crt',
      username: 'volveran',
      passwordEnv: 'VOLVERAN_INTERNAL_PASSWORD',
    };
    const chart = render({ caBundles: { bundles }, brokerProfiles: { profiles: [profile] } });
    expect(chart.one('ConfigMap').data!['profiles.yaml']).toContain('caFile: /etc/volveran/ca/broker-ca/ca.crt');
    expect(volumeAt(chart, '/etc/volveran/ca/broker-ca').volume).toBeDefined();
  });

  it('sets NODE_EXTRA_CA_CERTS to the named OIDC trust bundle file', () => {
    const chart = render({ caBundles: { bundles, oidcTrust: { bundle: 'corporate-ca', key: 'root.pem' } } });
    expect(env(chart, 'NODE_EXTRA_CA_CERTS')).toEqual({
      name: 'NODE_EXTRA_CA_CERTS',
      value: '/etc/volveran/ca/corporate-ca/root.pem',
    });
  });

  it('reads ca.crt from the OIDC trust bundle by default', () => {
    const chart = render({ caBundles: { bundles, oidcTrust: { bundle: 'broker-ca' } } });
    expect(env(chart, 'NODE_EXTRA_CA_CERTS').value).toBe('/etc/volveran/ca/broker-ca/ca.crt');
  });

  it('mounts nothing and sets no NODE_EXTRA_CA_CERTS by default', () => {
    const chart = render();
    expect(env(chart, 'NODE_EXTRA_CA_CERTS')).toBeUndefined();
    const paths = container(chart).volumeMounts.map((m: { mountPath: string }) => m.mountPath);
    expect(paths.filter((p: string) => p.startsWith('/etc/volveran'))).toEqual([]);
  });

  describe.each([false, true])('refusals (skip schema: %s)', (skipSchemaValidation) => {
    it('refuses an OIDC trust bundle that names no listed bundle', () => {
      expect(
        renderRefusal({ caBundles: { bundles, oidcTrust: { bundle: 'missing-ca' } } }, { skipSchemaValidation }),
      ).toContain('caBundles.oidcTrust.bundle names "missing-ca", which is not in caBundles.bundles');
    });

    it('refuses a bundle with both or neither of configMap and secret', () => {
      expect(
        renderRefusal({ caBundles: { bundles: [{ name: 'both', configMap: 'a', secret: 'b' }] } }, { skipSchemaValidation }),
      ).toContain('caBundles.bundles "both" needs exactly one of configMap or secret');
      expect(renderRefusal({ caBundles: { bundles: [{ name: 'neither' }] } }, { skipSchemaValidation })).toContain(
        'caBundles.bundles "neither" needs exactly one of configMap or secret',
      );
    });

    it('refuses two bundles with the same name', () => {
      expect(
        renderRefusal(
          { caBundles: { bundles: [bundles[0], { name: 'broker-ca', secret: 'other' }] } },
          { skipSchemaValidation },
        ),
      ).toContain('caBundles.bundles names "broker-ca" twice');
    });

    it('refuses a bundle name that is not a DNS label', () => {
      expect(
        renderRefusal({ caBundles: { bundles: [{ name: 'Broker_CA', configMap: 'x' }] } }, { skipSchemaValidation }),
      ).toContain('caBundles.bundles name "Broker_CA" must be lowercase letters, digits and "-"');
    });

    it('refuses NODE_EXTRA_CA_CERTS in extraEnv when an OIDC trust bundle sets it', () => {
      expect(
        renderRefusal(
          {
            caBundles: { bundles, oidcTrust: { bundle: 'broker-ca' } },
            extraEnv: [{ name: 'NODE_EXTRA_CA_CERTS', value: '/tmp/x.pem' }],
          },
          { skipSchemaValidation },
        ),
      ).toContain('extraEnv sets NODE_EXTRA_CA_CERTS: use caBundles.oidcTrust instead');
    });
  });
});
