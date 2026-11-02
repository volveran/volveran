// Startup configuration from the environment: every setting read together,
// the first problem reported by name.
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/server/config.js';

describe('loadConfig', () => {
  it('reads the run mode, Checkout limits and timing, and body retention', () => {
    const result = loadConfig({ VOLVERAN_OPERATOR: 'ana', VOLVERAN_CHECKOUT_MAX_MESSAGES: '50' }, '127.0.0.1');
    expect(result).toMatchObject({
      ok: true,
      config: {
        mode: { kind: 'solo', operator: 'ana' },
        checkoutLimits: { maxMessages: 50 },
        checkoutTiming: { timeLimitMs: 30 * 60_000 },
        bodyRetention: { maxAgeMs: 30 * 24 * 3_600_000 },
      },
    });
  });

  it('keeps the audit store on SQLite without a PostgreSQL URL, and on PostgreSQL with one', () => {
    expect(loadConfig({ VOLVERAN_OPERATOR: 'ana' }, '127.0.0.1')).toMatchObject({ config: { postgresUrl: null } });
    for (const url of ['postgres://volveran:pw@db:5432/volveran', 'postgresql://db/volveran']) {
      expect(loadConfig({ VOLVERAN_OPERATOR: 'ana', VOLVERAN_POSTGRES_URL: url }, '127.0.0.1')).toMatchObject({ config: { postgresUrl: url } });
    }
  });

  it('refuses a PostgreSQL URL it cannot use, without repeating what could be a password', () => {
    for (const url of ['', 'db.example.com/volveran', 'mysql://user:hunter2@db/volveran']) {
      const result = loadConfig({ VOLVERAN_OPERATOR: 'ana', VOLVERAN_POSTGRES_URL: url }, '127.0.0.1');
      expect(result).toEqual({ ok: false, error: expect.stringContaining('VOLVERAN_POSTGRES_URL') });
      expect(JSON.stringify(result)).not.toContain('hunter2');
    }
  });

  describe('TLS to PostgreSQL', () => {
    const url = 'postgres://volveran:hunter2@db:5432/volveran';
    const load = (env: Record<string, string>) => loadConfig({ VOLVERAN_OPERATOR: 'ana', VOLVERAN_POSTGRES_URL: url, ...env }, '127.0.0.1');
    const refusal = (env: Record<string, string>, expected: string) => {
      const result = load(env);
      expect(result).toEqual({ ok: false, error: expect.stringContaining(expected) });
      expect(JSON.stringify(result)).not.toContain('hunter2');
    };

    it('leaves TLS to the URL unless told', () => {
      expect(load({})).toMatchObject({ config: { postgresTls: null } });
      expect(load({ VOLVERAN_POSTGRES_REQUIRE_TLS: 'false' })).toMatchObject({ config: { postgresTls: null } });
    });

    it('requires it when told, and when given a CA', () => {
      expect(load({ VOLVERAN_POSTGRES_REQUIRE_TLS: 'true' })).toMatchObject({ config: { postgresTls: { caFile: null } } });
      expect(load({ VOLVERAN_POSTGRES_CA_FILE: '/ca.crt' })).toMatchObject({ config: { postgresTls: { caFile: '/ca.crt' } } });
    });

    it('refuses anything but true or false', () => {
      refusal({ VOLVERAN_POSTGRES_REQUIRE_TLS: 'yes' }, 'VOLVERAN_POSTGRES_REQUIRE_TLS must be true or false');
    });

    it('refuses a CA with TLS turned off', () => {
      refusal({ VOLVERAN_POSTGRES_REQUIRE_TLS: 'false', VOLVERAN_POSTGRES_CA_FILE: '/ca.crt' }, 'a CA is only for TLS');
    });

    it('refuses them without a URL, as the audit store is then on SQLite', () => {
      const result = loadConfig({ VOLVERAN_OPERATOR: 'ana', VOLVERAN_POSTGRES_REQUIRE_TLS: 'true' }, '127.0.0.1');
      expect(result).toEqual({ ok: false, error: expect.stringContaining('need VOLVERAN_POSTGRES_URL') });
    });

    it.each(['sslmode=disable', 'ssl=false', 'sslrootcert=/other.crt'])('refuses %s in the URL, which would override them', (parameter) => {
      const result = loadConfig({ VOLVERAN_OPERATOR: 'ana', VOLVERAN_POSTGRES_URL: `${url}?${parameter}`, VOLVERAN_POSTGRES_REQUIRE_TLS: 'true' }, '127.0.0.1');
      expect(result).toEqual({ ok: false, error: expect.stringContaining('out of VOLVERAN_POSTGRES_URL') });
      expect(JSON.stringify(result)).not.toContain('hunter2');
    });
  });

  it('reports the first setting that is wrong', () => {
    expect(loadConfig({ VOLVERAN_OPERATOR: 'ana', VOLVERAN_BODY_RETENTION_DAYS: 'never' }, '127.0.0.1')).toEqual({
      ok: false,
      error: expect.stringContaining('VOLVERAN_BODY_RETENTION_DAYS'),
    });
    expect(loadConfig({}, '0.0.0.0')).toEqual({ ok: false, error: expect.stringContaining('loopback') });
  });
});

describe('VOLVERAN_METRICS_PORT', () => {
  const load = (value?: string) => loadConfig({ VOLVERAN_OPERATOR: 'ana', VOLVERAN_METRICS_PORT: value }, '127.0.0.1');

  it('leaves the metrics listener off when unset or empty', () => {
    expect(load()).toMatchObject({ ok: true, config: { metricsPort: null } });
    expect(load('')).toMatchObject({ ok: true, config: { metricsPort: null } });
  });

  it('reads the port', () => {
    expect(load('9464')).toMatchObject({ ok: true, config: { metricsPort: 9464 } });
  });

  it.each(['0', '65536', '-1', '94.64', 'metrics', '9464 '])('refuses %j, naming the variable', (value) => {
    const result = load(value);
    expect(result.ok).toBe(false);
    expect(!result.ok && result.error).toContain('VOLVERAN_METRICS_PORT');
  });
});

describe('forwarding between Replicas', () => {
  const team = {
    VOLVERAN_AUTH: 'oidc',
    VOLVERAN_OIDC_ISSUER: 'https://idp.example.com',
    VOLVERAN_OIDC_CLIENT_ID: 'volveran',
    VOLVERAN_OIDC_CLIENT_SECRET: 'client-secret',
    VOLVERAN_OIDC_REDIRECT_URL: 'https://volveran.example.com/auth/callback',
    VOLVERAN_SESSION_SECRET: 's'.repeat(32),
  };
  const postgres = { VOLVERAN_POSTGRES_URL: 'postgres://db/volveran', VOLVERAN_SESSION_ENCRYPTION_KEY: 'k'.repeat(32) };
  const forwarding = { VOLVERAN_FORWARDING_SECRET: 'f'.repeat(32), VOLVERAN_FORWARDING_PORT: '8081', VOLVERAN_FORWARDING_ADDRESS: '10.0.0.7:8081' };
  const load = (env: Record<string, string | undefined>) => loadConfig({ ...team, ...postgres, ...env }, '0.0.0.0');

  it('is off without the secret', () => {
    expect(load({})).toMatchObject({ ok: true, config: { forwarding: null } });
  });

  it('reads the secret, the port and the address', () => {
    expect(load(forwarding)).toMatchObject({ ok: true, config: { forwarding: { secret: 'f'.repeat(32), port: 8081, address: '10.0.0.7:8081' } } });
    expect(load({ ...forwarding, VOLVERAN_FORWARDING_ADDRESS: '[fd00::7]:8081' })).toMatchObject({ config: { forwarding: { address: '[fd00::7]:8081' } } });
  });

  it('is off on SQLite and in Solo Mode, whatever is set', () => {
    expect(loadConfig({ ...team, ...forwarding, VOLVERAN_FORWARDING_PORT: 'nonsense' }, '0.0.0.0')).toMatchObject({ ok: true, config: { forwarding: null } });
    expect(loadConfig({ VOLVERAN_OPERATOR: 'ana', ...postgres, ...forwarding }, '127.0.0.1')).toMatchObject({ ok: true, config: { forwarding: null } });
  });

  it.each([
    ['a short secret', { VOLVERAN_FORWARDING_SECRET: 'short' }, 'VOLVERAN_FORWARDING_SECRET'],
    ['no port', { VOLVERAN_FORWARDING_PORT: undefined }, 'VOLVERAN_FORWARDING_PORT'],
    ['a port out of range', { VOLVERAN_FORWARDING_PORT: '70000' }, 'VOLVERAN_FORWARDING_PORT'],
    ['no address', { VOLVERAN_FORWARDING_ADDRESS: undefined }, 'VOLVERAN_FORWARDING_ADDRESS'],
    ['an address without a port', { VOLVERAN_FORWARDING_ADDRESS: '10.0.0.7' }, 'VOLVERAN_FORWARDING_ADDRESS'],
    ['an address with a path', { VOLVERAN_FORWARDING_ADDRESS: '10.0.0.7:8081/api' }, 'VOLVERAN_FORWARDING_ADDRESS'],
  ])('refuses %s', (_, change, named) => {
    const result = load({ ...forwarding, ...change });
    expect(result.ok).toBe(false);
    expect(!result.ok && result.error).toContain(named);
  });
});
