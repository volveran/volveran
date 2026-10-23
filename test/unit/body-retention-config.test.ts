import { describe, expect, it } from 'vitest';
import { bodyStoreUsage, parseBodyRetention } from '../../src/server/audit/body-retention.js';

const DAY = 24 * 60 * 60 * 1000;
const GIB = 1024 ** 3;

describe('parseBodyRetention', () => {
  it('keeps bodies 30 days or up to 1 GiB, checked hourly, by default', () => {
    expect(parseBodyRetention({})).toEqual({
      ok: true,
      retention: { maxAgeMs: 30 * DAY, maxBodyBytes: GIB, intervalMs: 60 * 60 * 1000 },
    });
  });

  it('reads the age in days, the size in bytes or KiB/MiB/GiB, and the interval in minutes', () => {
    const parsed = parseBodyRetention({
      VOLVERAN_BODY_RETENTION_DAYS: '7',
      VOLVERAN_BODY_RETENTION_MAX_BYTES: '512MiB',
      VOLVERAN_BODY_RETENTION_INTERVAL_MINUTES: '5',
    });
    expect(parsed).toEqual({ ok: true, retention: { maxAgeMs: 7 * DAY, maxBodyBytes: 512 * 1024 ** 2, intervalMs: 5 * 60 * 1000 } });
    expect(parseBodyRetention({ VOLVERAN_BODY_RETENTION_MAX_BYTES: '2 GiB' })).toMatchObject({
      retention: { maxBodyBytes: 2 * GIB },
    });
    expect(parseBodyRetention({ VOLVERAN_BODY_RETENTION_MAX_BYTES: '1000' })).toMatchObject({
      retention: { maxBodyBytes: 1000 },
    });
  });

  it.each([
    ['VOLVERAN_BODY_RETENTION_DAYS', '0'],
    ['VOLVERAN_BODY_RETENTION_DAYS', '1.5'],
    ['VOLVERAN_BODY_RETENTION_MAX_BYTES', '1GB'],
    ['VOLVERAN_BODY_RETENTION_MAX_BYTES', '-1'],
    ['VOLVERAN_BODY_RETENTION_INTERVAL_MINUTES', 'hourly'],
  ])('refuses %s=%s, naming the variable', (name, value) => {
    const parsed = parseBodyRetention({ [name]: value });
    expect(parsed.ok).toBe(false);
    expect(!parsed.ok && parsed.error).toContain(name);
  });
});

describe('bodyStoreUsage', () => {
  const retention = { maxAgeMs: 30 * DAY, maxBodyBytes: 1000, intervalMs: 1 };

  it('warns once the stored bodies reach 90% of the size limit', () => {
    expect(bodyStoreUsage(899, retention)).toEqual({ storedBodyBytes: 899, maxBodyBytes: 1000, maxAgeDays: 30, nearLimit: false });
    expect(bodyStoreUsage(900, retention).nearLimit).toBe(true);
  });
});
