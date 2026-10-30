// Volverán's own settings are named values that become the documented
// VOLVERAN_* variables, so nobody has to know the variable names; extraEnv
// passes any other variable through for settings the chart does not name yet.
import { describe, expect, it } from 'vitest';
import { container, env, render, renderRefusal } from './render.js';

describe('settings', () => {
  it.each([
    ['checkoutMaxMessages', 5000, 'VOLVERAN_CHECKOUT_MAX_MESSAGES', '5000'],
    ['checkoutMaxMb', 1000000, 'VOLVERAN_CHECKOUT_MAX_MB', '1000000'],
    ['checkoutTimeLimitMinutes', 90, 'VOLVERAN_CHECKOUT_TIME_LIMIT_MINUTES', '90'],
    ['checkoutHeartbeatSeconds', 300, 'VOLVERAN_CHECKOUT_HEARTBEAT_SECONDS', '300'],
    ['bodyRetentionDays', 365, 'VOLVERAN_BODY_RETENTION_DAYS', '365'],
    ['bodyRetentionMaxBytes', '20GiB', 'VOLVERAN_BODY_RETENTION_MAX_BYTES', '20GiB'],
    ['bodyRetentionMaxBytes', 5368709120, 'VOLVERAN_BODY_RETENTION_MAX_BYTES', '5368709120'],
    ['bodyRetentionIntervalMinutes', 15, 'VOLVERAN_BODY_RETENTION_INTERVAL_MINUTES', '15'],
    ['historyIntervalSeconds', 300, 'VOLVERAN_HISTORY_INTERVAL_SECONDS', '300'],
    ['historyRetentionDays', 30, 'VOLVERAN_HISTORY_RETENTION_DAYS', '30'],
  ])('settings.%s: %s becomes %s=%s', (setting, value, variable, expected) => {
    expect(env(render({ settings: { [setting]: value } }), variable)).toEqual({ name: variable, value: expected });
  });

  it("sets none of them by default, so Volverán's own defaults apply", () => {
    const names = container(render()).env.map((e: { name: string }) => e.name);
    expect(names.filter((name: string) => /CHECKOUT|RETENTION|HISTORY/.test(name))).toEqual([]);
  });

  it('refuses a setting outside the range Volverán accepts', () => {
    expect(renderRefusal({ settings: { checkoutHeartbeatSeconds: 5 } })).toContain('/settings/checkoutHeartbeatSeconds');
    expect(renderRefusal({ settings: { bodyRetentionMaxBytes: '1 gigabyte' } })).toContain(
      '/settings/bodyRetentionMaxBytes',
    );
    expect(renderRefusal({ settings: { historyIntervalSeconds: 14 } })).toContain('/settings/historyIntervalSeconds');
    expect(renderRefusal({ settings: { historyIntervalSeconds: 3601 } })).toContain('/settings/historyIntervalSeconds');
    expect(renderRefusal({ settings: { historyRetentionDays: 0 } })).toContain('/settings/historyRetentionDays');
    expect(renderRefusal({ settings: { historyRetentionDays: 91 } })).toContain('/settings/historyRetentionDays');
  });
});

describe('extraEnv', () => {
  const extraEnv = [
    { name: 'VOLVERAN_FUTURE_SETTING', value: 'enabled' },
    { name: 'HTTPS_PROXY', valueFrom: { secretKeyRef: { name: 'proxy', key: 'url' } } },
  ];

  it('passes extra variables through to the container unchanged', () => {
    const chart = render({ extraEnv });
    expect(env(chart, 'VOLVERAN_FUTURE_SETTING')).toEqual(extraEnv[0]);
    expect(env(chart, 'HTTPS_PROXY')).toEqual(extraEnv[1]);
  });

  it.each([false, true])(
    'refuses a variable the chart sets itself, such as VOLVERAN_AUTH (skip schema: %s)',
    (skipSchemaValidation) => {
      const message = renderRefusal({ extraEnv: [{ name: 'VOLVERAN_AUTH', value: 'none' }] }, { skipSchemaValidation });
      expect(message).toContain('extraEnv sets VOLVERAN_AUTH, which the chart sets itself');
    },
  );

  it('refuses a variable that a named setting covers, pointing at the setting', () => {
    const message = renderRefusal({ extraEnv: [{ name: 'VOLVERAN_CHECKOUT_MAX_MB', value: '200' }] });
    expect(message).toContain('extraEnv sets VOLVERAN_CHECKOUT_MAX_MB: use settings.checkoutMaxMb');
  });
});
