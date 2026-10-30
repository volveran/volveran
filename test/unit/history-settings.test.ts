// The depth history settings: how often to sample and how long to keep Samples.
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/server/config.js';

const load = (env: Record<string, string>) => loadConfig({ VOLVERAN_OPERATOR: 'ana', ...env }, '127.0.0.1');

describe('depth history settings', () => {
  it('samples once a minute and keeps 14 days by default', () => {
    expect(load({})).toMatchObject({ ok: true, config: { historyIntervalMs: 60_000, historyRetentionMs: 14 * 86_400_000 } });
  });

  it('reads the interval in seconds and the retention in days', () => {
    expect(load({ VOLVERAN_HISTORY_INTERVAL_SECONDS: '15', VOLVERAN_HISTORY_RETENTION_DAYS: '90' })).toMatchObject({
      config: { historyIntervalMs: 15_000, historyRetentionMs: 90 * 86_400_000 },
    });
    expect(load({ VOLVERAN_HISTORY_INTERVAL_SECONDS: '3600', VOLVERAN_HISTORY_RETENTION_DAYS: '1' })).toMatchObject({
      config: { historyIntervalMs: 3_600_000, historyRetentionMs: 86_400_000 },
    });
  });

  it.each([
    ['VOLVERAN_HISTORY_INTERVAL_SECONDS', '14'],
    ['VOLVERAN_HISTORY_INTERVAL_SECONDS', '3601'],
    ['VOLVERAN_HISTORY_INTERVAL_SECONDS', '1.5'],
    ['VOLVERAN_HISTORY_INTERVAL_SECONDS', 'often'],
    ['VOLVERAN_HISTORY_RETENTION_DAYS', '0'],
    ['VOLVERAN_HISTORY_RETENTION_DAYS', '91'],
    ['VOLVERAN_HISTORY_RETENTION_DAYS', 'forever'],
  ])('refuses %s=%s, naming the variable', (name, value) => {
    expect(load({ [name]: value })).toEqual({ ok: false, error: expect.stringContaining(name) });
  });
});
