// Credentials only ever come from Secrets the platform engineer names. The
// chart references them and never renders a Secret of its own.
import { describe, expect, it } from 'vitest';
import { container, env, render } from './render.js';

describe('secrets', () => {
  it('reads the OIDC client secret and the session secret from oidc.existingSecret', () => {
    const chart = render();
    expect(env(chart, 'VOLVERAN_OIDC_CLIENT_SECRET')).toEqual({
      name: 'VOLVERAN_OIDC_CLIENT_SECRET',
      valueFrom: { secretKeyRef: { name: 'volveran-oidc', key: 'client-secret' } },
    });
    expect(env(chart, 'VOLVERAN_SESSION_SECRET')).toEqual({
      name: 'VOLVERAN_SESSION_SECRET',
      valueFrom: { secretKeyRef: { name: 'volveran-oidc', key: 'session-secret' } },
    });
  });

  it('takes the key names from values', () => {
    const chart = render({ oidc: { clientSecretKey: 'oidc-client', sessionSecretKey: 'cookie-key' } });
    expect(env(chart, 'VOLVERAN_OIDC_CLIENT_SECRET').valueFrom.secretKeyRef.key).toBe('oidc-client');
    expect(env(chart, 'VOLVERAN_SESSION_SECRET').valueFrom.secretKeyRef.key).toBe('cookie-key');
  });

  it("turns every key of the broker passwords Secret into an environment variable, matching each profile's passwordEnv", () => {
    expect(container(render()).envFrom).toEqual([{ secretRef: { name: 'volveran-broker-passwords' } }]);
  });

  it('renders no Secret object, and no credential anywhere in the manifests', () => {
    const chart = render();
    expect(chart.ofKind('Secret')).toEqual([]);
    const text = JSON.stringify(chart.objects);
    expect(text).not.toMatch(/"password"\s*:/i);
  });

  it('refuses a password written into a Broker Profile', () => {
    // The values schema mirrors the profiles YAML, which has no password key.
    expect(() =>
      render({
        brokerProfiles: {
          profiles: [
            {
              name: 'prod',
              managementUrl: 'https://rabbit.example.com:15671',
              amqpUrl: 'amqps://rabbit.example.com:5671',
              username: 'volveran',
              passwordEnv: 'VOLVERAN_PROD_PASSWORD',
              password: 'hunter2',
            },
          ],
        },
      }),
    ).toThrow(/password/);
  });
});
