// A Broker Profile's `canary`: how long a Canary is watched (the Watch
// Window), a duration from 5s to 10m, 30s by default; and above how many
// Replays an Apply must start with one (requiredAbove), none by default.
import { describe, expect, it } from 'vitest';
import { parseProfiles } from '../../src/server/profiles.js';

const profileWith = (extra: string[]) =>
  [
    'profiles:',
    '  - name: prod',
    '    managementUrl: http://localhost:15672',
    '    amqpUrl: amqp://localhost:5672',
    '    username: guest',
    '    passwordEnv: PROD_PW',
    ...extra,
  ].join('\n');

const parse = (extra: string[]) => parseProfiles(profileWith(extra), {}, 'profiles.yaml')[0]!;

describe('Broker Profile canary', () => {
  it('watches for 30 seconds by default', () => {
    expect(parse([]).canary).toEqual({ watchWindowMs: 30_000, requiredAbove: null });
    expect(parse(['    canary: {}']).canary).toEqual({ watchWindowMs: 30_000, requiredAbove: null });
  });

  it('takes a Watch Window from 5s to 10m', () => {
    expect(parse(['    canary:', '      watchWindow: 5s']).canary.watchWindowMs).toBe(5_000);
    expect(parse(['    canary:', '      watchWindow: 1m30s']).canary.watchWindowMs).toBe(90_000);
    expect(parse(['    canary:', '      watchWindow: 10m']).canary.watchWindowMs).toBe(600_000);
  });

  it('requires a Canary above requiredAbove Replays, from 0 up', () => {
    expect(parse(['    canary:', '      requiredAbove: 0']).canary).toEqual({ watchWindowMs: 30_000, requiredAbove: 0 });
    expect(parse(['    canary:', '      requiredAbove: 20', '      watchWindow: 1m']).canary).toEqual({
      watchWindowMs: 60_000,
      requiredAbove: 20,
    });
  });

  it('refuses a negative, fractional or non-number requiredAbove, naming the profile and the key', () => {
    for (const value of ['-1', '2.5', 'ten', 'true']) {
      expect(() => parse(['    canary:', `      requiredAbove: ${value}`])).toThrow(
        'profiles.yaml: profiles[0] ("prod").canary.requiredAbove must be a whole number of Replays, 0 or more',
      );
    }
  });

  it('refuses a Watch Window out of range or not a duration, naming the profile and the key', () => {
    for (const value of ['4s', '11m', '30', '0s', 'soon']) {
      expect(() => parse(['    canary:', `      watchWindow: ${value}`])).toThrow(
        'profiles.yaml: profiles[0] ("prod").canary.watchWindow must be a duration from 5s to 10m',
      );
    }
  });

  it('refuses a canary that is not a mapping, and unknown keys', () => {
    expect(() => parse(['    canary: true'])).toThrow('profiles.yaml: profiles[0] ("prod").canary must be a mapping');
    expect(() => parse(['    canary:', '      window: 10s'])).toThrow(
      'profiles.yaml: profiles[0] ("prod").canary.window is not a key of canary',
    );
  });
});
