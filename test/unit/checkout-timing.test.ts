import { describe, expect, it } from 'vitest';
import { consumerTimeoutMs, parseCheckoutTiming, remainingMs } from '../../src/server/triage/checkout-timing.js';

describe('parseCheckoutTiming', () => {
  it('defaults to a 30 minute time limit, a 2 minute heartbeat window and a 1 minute backstop margin', () => {
    expect(parseCheckoutTiming({})).toEqual({
      ok: true,
      timing: { timeLimitMs: 1_800_000, heartbeatWindowMs: 120_000, consumerTimeoutMarginMs: 60_000 },
    });
  });

  it('reads VOLVERAN_CHECKOUT_TIME_LIMIT_MINUTES and VOLVERAN_CHECKOUT_HEARTBEAT_SECONDS', () => {
    expect(
      parseCheckoutTiming({ VOLVERAN_CHECKOUT_TIME_LIMIT_MINUTES: '5', VOLVERAN_CHECKOUT_HEARTBEAT_SECONDS: '30' }),
    ).toEqual({ ok: true, timing: { timeLimitMs: 300_000, heartbeatWindowMs: 30_000, consumerTimeoutMarginMs: 60_000 } });
  });

  it('refuses values that are not whole numbers in range, naming the variable', () => {
    for (const [env, name] of [
      [{ VOLVERAN_CHECKOUT_TIME_LIMIT_MINUTES: '0' }, 'VOLVERAN_CHECKOUT_TIME_LIMIT_MINUTES'],
      [{ VOLVERAN_CHECKOUT_TIME_LIMIT_MINUTES: '1441' }, 'VOLVERAN_CHECKOUT_TIME_LIMIT_MINUTES'],
      [{ VOLVERAN_CHECKOUT_TIME_LIMIT_MINUTES: '2.5' }, 'VOLVERAN_CHECKOUT_TIME_LIMIT_MINUTES'],
      [{ VOLVERAN_CHECKOUT_HEARTBEAT_SECONDS: '9' }, 'VOLVERAN_CHECKOUT_HEARTBEAT_SECONDS'],
      [{ VOLVERAN_CHECKOUT_HEARTBEAT_SECONDS: 'often' }, 'VOLVERAN_CHECKOUT_HEARTBEAT_SECONDS'],
    ] as const) {
      const result = parseCheckoutTiming(env);
      expect(result.ok).toBe(false);
      expect(!result.ok && result.error).toContain(name);
    }
  });
});

describe('consumerTimeoutMs', () => {
  it('is the time limit plus the margin', () => {
    expect(consumerTimeoutMs({ timeLimitMs: 1_800_000, heartbeatWindowMs: 120_000, consumerTimeoutMarginMs: 60_000 })).toBe(
      1_860_000,
    );
  });
});

describe('remainingMs', () => {
  const expiresAt = new Date('2026-10-23T12:30:00Z');
  it('counts down to the expiry', () => {
    expect(remainingMs(expiresAt, new Date('2026-10-23T12:29:30Z'))).toBe(30_000);
  });
  it('never goes below 0', () => {
    expect(remainingMs(expiresAt, new Date('2026-10-23T12:31:00Z'))).toBe(0);
  });
});
