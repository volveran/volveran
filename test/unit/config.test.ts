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
