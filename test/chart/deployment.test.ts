// The Deployment's fixed behaviour: one replica, Recreate, Team Mode on all
// interfaces, no service account token, and time to end Checkouts on shutdown.
import { describe, expect, it } from 'vitest';
import { container, env, podSpec, render } from './render.js';

describe('Deployment', () => {
  it('runs one replica with the Recreate strategy, so two pods never share the audit store', () => {
    const deployment = render().one('Deployment');
    expect(deployment.spec.replicas).toBe(1);
    expect(deployment.spec.strategy).toEqual({ type: 'Recreate' });
  });

  it('always runs Team Mode listening on all interfaces of the pod', () => {
    const chart = render();
    expect(env(chart, 'VOLVERAN_AUTH')).toEqual({ name: 'VOLVERAN_AUTH', value: 'oidc' });
    expect(env(chart, 'VOLVERAN_HOST')).toEqual({ name: 'VOLVERAN_HOST', value: '0.0.0.0' });
    expect(env(chart, 'VOLVERAN_PORT')).toEqual({ name: 'VOLVERAN_PORT', value: '8080' });
  });

  it('passes the OIDC settings as plain values', () => {
    const chart = render({ oidc: { scopes: 'openid email' } });
    expect(env(chart, 'VOLVERAN_OIDC_ISSUER').value).toBe('https://login.example.com/realms/ops');
    expect(env(chart, 'VOLVERAN_OIDC_CLIENT_ID').value).toBe('volveran');
    expect(env(chart, 'VOLVERAN_OIDC_REDIRECT_URL').value).toBe('https://volveran.example.com/auth/callback');
    expect(env(chart, 'VOLVERAN_OIDC_SCOPES').value).toBe('openid email');
    expect(env(render(), 'VOLVERAN_OIDC_SCOPES').value).toBe('openid email profile');
  });

  it('names the groups claim, for Roles', () => {
    expect(env(render(), 'VOLVERAN_OIDC_GROUPS_CLAIM').value).toBe('groups');
    expect(env(render({ oidc: { groupsClaim: 'teams' } }), 'VOLVERAN_OIDC_GROUPS_CLAIM').value).toBe('teams');
  });

  it('mounts no service account token unless turned on', () => {
    expect(podSpec(render()).automountServiceAccountToken).toBe(false);
    expect(podSpec(render({ pod: { automountServiceAccountToken: true } })).automountServiceAccountToken).toBe(true);
  });

  it('gives SIGTERM 60 seconds by default to end every active Checkout', () => {
    expect(podSpec(render()).terminationGracePeriodSeconds).toBe(60);
    expect(podSpec(render({ pod: { terminationGracePeriodSeconds: 300 } })).terminationGracePeriodSeconds).toBe(300);
  });

  it('requests and limits resources sized for a 100 MB Checkout', () => {
    expect(container(render()).resources).toEqual({
      requests: { cpu: '100m', memory: '256Mi' },
      limits: { cpu: '1', memory: '512Mi' },
    });
  });
});
