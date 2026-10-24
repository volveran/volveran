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

  it('reports the first setting that is wrong', () => {
    expect(loadConfig({ VOLVERAN_OPERATOR: 'ana', VOLVERAN_BODY_RETENTION_DAYS: 'never' }, '127.0.0.1')).toEqual({
      ok: false,
      error: expect.stringContaining('VOLVERAN_BODY_RETENTION_DAYS'),
    });
    expect(loadConfig({}, '0.0.0.0')).toEqual({ ok: false, error: expect.stringContaining('loopback') });
  });
});
