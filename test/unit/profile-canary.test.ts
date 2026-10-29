// A Broker Profile's `canary`: how long a Canary is watched (the Watch
// Window), in seconds from 5 to 600, 30 by default.
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
    expect(parse([]).canary).toEqual({ watchWindowMs: 30_000 });
    expect(parse(['    canary: {}']).canary).toEqual({ watchWindowMs: 30_000 });
  });

  it('takes a Watch Window in seconds from 5 to 600', () => {
    expect(parse(['    canary:', '      watchWindow: 5']).canary).toEqual({ watchWindowMs: 5_000 });
    expect(parse(['    canary:', '      watchWindow: 600']).canary).toEqual({ watchWindowMs: 600_000 });
  });

  it('refuses a Watch Window out of range, naming the profile and the key', () => {
    for (const value of ['4', '601', '"30s"', '0']) {
      expect(() => parse(['    canary:', `      watchWindow: ${value}`])).toThrow(
        'profiles.yaml: profiles[0] ("prod").canary.watchWindow must be a number of seconds from 5 to 600',
      );
    }
  });

  it('refuses a canary that is not a mapping, and unknown keys', () => {
    expect(() => parse(['    canary: true'])).toThrow('profiles.yaml: profiles[0] ("prod").canary must be a mapping');
    expect(() => parse(['    canary:', '      window: 10'])).toThrow(
      'profiles.yaml: profiles[0] ("prod").canary.window is not a key of canary',
    );
  });
});
