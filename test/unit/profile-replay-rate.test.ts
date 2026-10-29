// A Broker Profile's `replayRate`: the default Replay Rate an Apply runs at,
// and the most an Operator may choose, in Messages per second.
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

describe('Broker Profile replayRate', () => {
  it('is unthrottled without one', () => {
    expect(parse([]).replayRate).toEqual({ default: null, max: null });
  });

  it('reads a default and a maximum', () => {
    expect(parse(['    replayRate:', '      default: 5', '      max: 50']).replayRate).toEqual({ default: 5, max: 50 });
    expect(parse(['    replayRate:', '      max: 0.5']).replayRate).toEqual({ default: null, max: 0.5 });
    expect(parse(['    replayRate:', '      default: 20']).replayRate).toEqual({ default: 20, max: null });
  });

  it('refuses a default above the maximum, naming the profile and both values', () => {
    expect(() => parse(['    replayRate:', '      default: 100', '      max: 10'])).toThrow(
      'profiles.yaml: profiles[0] ("prod").replayRate.default (100) is above replayRate.max (10)',
    );
  });

  it('refuses a rate that is not a number from 0.1 to 1,000', () => {
    for (const value of ['"fast"', '0', '0.05', '1001', '-3', 'true']) {
      expect(() => parse(['    replayRate:', `      max: ${value}`])).toThrow(
        'profiles.yaml: profiles[0] ("prod").replayRate.max must be a number of Messages per second from 0.1 to 1000',
      );
    }
  });

  it('refuses a replayRate that is not a mapping of default and max', () => {
    expect(() => parse(['    replayRate: 10'])).toThrow(
      'profiles.yaml: profiles[0] ("prod").replayRate must be a mapping with default and/or max',
    );
    expect(() => parse(['    replayRate:', '      min: 1'])).toThrow(
      'profiles.yaml: profiles[0] ("prod").replayRate.min is not a key of replayRate; it takes default and max',
    );
  });
});
