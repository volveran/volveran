// How Volverán runs (ADR 0002): Solo Mode or Team Mode, from the environment.
import { describe, expect, it } from 'vitest';
import { resolveRunMode } from '../../src/server/run-mode.js';

const teamEnv = {
  VOLVERAN_AUTH: 'oidc',
  VOLVERAN_OIDC_ISSUER: 'https://sso.example.com/realms/ops',
  VOLVERAN_OIDC_CLIENT_ID: 'volveran',
  VOLVERAN_OIDC_CLIENT_SECRET: 'client-secret',
  VOLVERAN_OIDC_REDIRECT_URL: 'https://volveran.example.com/auth/callback',
  VOLVERAN_SESSION_SECRET: 'a-session-secret-of-at-least-32-characters',
};

const errorOf = (env: Record<string, string | undefined>, host = '0.0.0.0') => {
  const result = resolveRunMode(env, host);
  if (result.ok) throw new Error('expected a configuration error');
  return result.error;
};

describe('Team Mode settings', () => {
  it('reads the OIDC provider, client and session secret from the environment', () => {
    expect(resolveRunMode(teamEnv, '0.0.0.0')).toEqual({
      ok: true,
      mode: {
        kind: 'team',
        oidc: {
          issuer: 'https://sso.example.com/realms/ops',
          clientId: 'volveran',
          clientSecret: 'client-secret',
          redirectUrl: 'https://volveran.example.com/auth/callback',
          scopes: ['openid', 'email', 'profile'],
        },
        sessionSecret: 'a-session-secret-of-at-least-32-characters',
      },
    });
  });

  it('listens on any address, since every request needs a signed-in Operator', () => {
    for (const host of ['0.0.0.0', '::', '192.0.2.10', '127.0.0.1']) {
      expect(resolveRunMode(teamEnv, host).ok).toBe(true);
    }
  });

  it('takes scopes from VOLVERAN_OIDC_SCOPES', () => {
    const result = resolveRunMode({ ...teamEnv, VOLVERAN_OIDC_SCOPES: 'openid  email groups' }, '0.0.0.0');
    expect(result.ok && result.mode.kind === 'team' && result.mode.oidc.scopes).toEqual(['openid', 'email', 'groups']);
  });

  it('requires the openid scope', () => {
    expect(errorOf({ ...teamEnv, VOLVERAN_OIDC_SCOPES: 'email profile' })).toMatch(/VOLVERAN_OIDC_SCOPES.*openid/);
  });

  it('names every missing setting at once', () => {
    const error = errorOf({ VOLVERAN_AUTH: 'oidc' });
    for (const name of [
      'VOLVERAN_OIDC_ISSUER',
      'VOLVERAN_OIDC_CLIENT_ID',
      'VOLVERAN_OIDC_CLIENT_SECRET',
      'VOLVERAN_OIDC_REDIRECT_URL',
      'VOLVERAN_SESSION_SECRET',
    ]) {
      expect(error).toContain(name);
    }
  });

  it('refuses a short session secret', () => {
    expect(errorOf({ ...teamEnv, VOLVERAN_SESSION_SECRET: 'too-short' })).toMatch(/VOLVERAN_SESSION_SECRET.*32/);
  });

  it('refuses a redirect URL that is not the /auth/callback route', () => {
    expect(errorOf({ ...teamEnv, VOLVERAN_OIDC_REDIRECT_URL: 'https://volveran.example.com/callback' })).toMatch(
      /VOLVERAN_OIDC_REDIRECT_URL.*\/auth\/callback/,
    );
  });

  it.each(['VOLVERAN_OIDC_ISSUER', 'VOLVERAN_OIDC_REDIRECT_URL'])('refuses %s that is not a URL', (name) => {
    expect(errorOf({ ...teamEnv, [name]: 'not a url' })).toMatch(new RegExp(`${name}.*URL`));
  });

  it.each(['VOLVERAN_OIDC_ISSUER', 'VOLVERAN_OIDC_REDIRECT_URL'])(
    'refuses plain http for %s unless it is on this machine',
    (name) => {
      const url = name === 'VOLVERAN_OIDC_ISSUER' ? 'http://sso.example.com/realms/ops' : 'http://volveran.example.com/auth/callback';
      expect(errorOf({ ...teamEnv, [name]: url })).toMatch(new RegExp(`${name}.*https`));
      const local = name === 'VOLVERAN_OIDC_ISSUER' ? 'http://127.0.0.1:8081/default' : 'http://localhost:8080/auth/callback';
      expect(resolveRunMode({ ...teamEnv, [name]: local }, '127.0.0.1').ok).toBe(true);
    },
  );
});

describe('Solo Mode settings', () => {
  it('is the default, with the Operator named by VOLVERAN_OPERATOR', () => {
    expect(resolveRunMode({ VOLVERAN_OPERATOR: 'ana', USER: 'x' }, '127.0.0.1')).toEqual({
      ok: true,
      mode: { kind: 'solo', operator: 'ana' },
    });
  });

  it('refuses a non-loopback address and points at Team Mode', () => {
    expect(errorOf({ VOLVERAN_OPERATOR: 'ana' })).toMatch(/loopback.*VOLVERAN_AUTH=oidc/s);
  });
});
