// VOLVERAN_PUBLIC_URL: the base of the links in notifications.
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/server/config.js';

const solo = { VOLVERAN_OPERATOR: 'ana' };
const team = {
  VOLVERAN_AUTH: 'oidc',
  VOLVERAN_OIDC_ISSUER: 'https://sso.example.com',
  VOLVERAN_OIDC_CLIENT_ID: 'volveran',
  VOLVERAN_OIDC_CLIENT_SECRET: 'x',
  VOLVERAN_OIDC_REDIRECT_URL: 'https://volveran.example.com:8443/base/auth/callback',
  VOLVERAN_SESSION_SECRET: 'a'.repeat(32),
};
const publicUrl = (env: Record<string, string>, host = '127.0.0.1') => {
  const loaded = loadConfig(env, host);
  if (!loaded.ok) throw new Error(loaded.error);
  return loaded.config.publicUrl;
};

describe('VOLVERAN_PUBLIC_URL', () => {
  it('is null in Solo Mode without it: notifications carry no link', () => {
    expect(publicUrl(solo)).toBeNull();
  });

  it('defaults in Team Mode to the origin of VOLVERAN_OIDC_REDIRECT_URL', () => {
    expect(publicUrl(team, '0.0.0.0')).toBe('https://volveran.example.com:8443');
  });

  it('wins over the default, without a trailing slash', () => {
    expect(publicUrl({ ...team, VOLVERAN_PUBLIC_URL: 'https://dlq.example.com/volveran/' }, '0.0.0.0')).toBe(
      'https://dlq.example.com/volveran',
    );
    expect(publicUrl({ ...solo, VOLVERAN_PUBLIC_URL: 'http://localhost:8080' })).toBe('http://localhost:8080');
  });

  it.each(['volveran.example.com', 'ftp://volveran.example.com', 'https://a.example.com/?x=1', 'https://a.example.com/#x', 'https://u:p@a.example.com'])(
    'refuses %s',
    (value) => {
      expect(loadConfig({ ...solo, VOLVERAN_PUBLIC_URL: value }, '127.0.0.1')).toEqual({
        ok: false,
        error: expect.stringContaining('VOLVERAN_PUBLIC_URL'),
      });
    },
  );
});

describe('VOLVERAN_HISTORY_RETENTION_DAYS', () => {
  it('defaults to 14 days', () => {
    const loaded = loadConfig(solo, '127.0.0.1');
    expect(loaded.ok && loaded.config.historyRetentionMs).toBe(14 * 24 * 3_600_000);
  });

  it.each(['0', '91', 'soon', '1.5'])('refuses %s (1 to 90)', (value) => {
    expect(loadConfig({ ...solo, VOLVERAN_HISTORY_RETENTION_DAYS: value }, '127.0.0.1')).toEqual({
      ok: false,
      error: expect.stringContaining('VOLVERAN_HISTORY_RETENTION_DAYS'),
    });
  });
});
