// A Broker Profile's `alerts`: each rule's declaration and the refusals at
// startup, which name the profile, the rule and the key.
import { describe, expect, it } from 'vitest';
import { parseProfilesFile, ProfilesConfigError } from '../../src/server/profiles.js';

const profile = (alerts: unknown, extra: Record<string, unknown> = {}) => ({
  name: 'prod',
  managementUrl: 'http://localhost:15672',
  amqpUrl: 'amqp://localhost:5672',
  username: 'guest',
  passwordEnv: 'PW',
  vhosts: ['/'],
  alerts,
  ...extra,
});
const parse = (alerts: unknown, extra?: Record<string, unknown>) =>
  parseProfilesFile(
    JSON.stringify({ alertDestinations: [{ name: 'ops', type: 'slack', urlEnv: 'URL' }], profiles: [profile(alerts, extra)] }),
    { URL: 'https://hooks.example/x', PW: 'x' },
  ).profiles[0]!.alerts;
const rule = (over: Record<string, unknown> = {}) => ({ name: 'deep', destinations: ['ops'], when: { vhost: '/', queue: 'a.dlq', depthAbove: 10 }, ...over });
const refuses = (alerts: unknown, message: RegExp | string, extra?: Record<string, unknown>) => {
  expect(() => parse(alerts, extra)).toThrow(ProfilesConfigError);
  expect(() => parse(alerts, extra)).toThrow(message);
};

describe('alerts in the profiles file', () => {
  it('is empty when the profile declares none', () => {
    expect(parse(undefined)).toEqual([]);
  });

  it('reads each queue condition, with `for` and `repeatEvery`', () => {
    expect(parse([rule({ for: '5m', repeatEvery: '1h' })])).toEqual([
      { name: 'deep', destinations: ['ops'], when: { kind: 'depthAbove', vhost: '/', queue: 'a.dlq', queuePattern: null, threshold: 10 }, forMs: 300_000, repeatEveryMs: 3_600_000 },
    ]);
    expect(parse([rule({ when: { vhost: '/', queuePattern: '*.dlq', anyArrival: true } })])[0]!.when).toEqual({ kind: 'anyArrival', vhost: '/', queue: null, queuePattern: '*.dlq' });
    expect(parse([rule({ when: { vhost: '/', queue: 'a', arrivalsAbove: { count: 5, within: '10m' } } })])[0]).toMatchObject({
      when: { kind: 'arrivalsAbove', count: 5, withinMs: 600_000 }, forMs: 0, repeatEveryMs: null,
    });
  });

  it('refuses an unknown destination, naming the profile, rule and name', () => {
    refuses([rule({ destinations: ['nope'] })], /profiles\[0\] \("prod"\)\.alerts\[0\] \("deep"\)\.destinations names "nope"/);
  });

  it('refuses a queue condition on an operatorToken profile', () => {
    expect(() =>
      parseProfilesFile(
        JSON.stringify({
          alertDestinations: [{ name: 'ops', type: 'slack', urlEnv: 'URL' }],
          profiles: [{ name: 'prod', managementUrl: 'http://x', amqpUrl: 'amqp://x', credentials: 'operatorToken', alerts: [rule()] }],
        }),
        { URL: 'https://hooks.example/x' },
      ),
    ).toThrow(/operatorToken/);
  });

  it('refuses duplicate names', () => {
    refuses([rule(), rule()], /"deep"\)\.name is used by another Alert Rule/);
  });

  it('refuses malformed patterns and durations', () => {
    refuses([rule({ when: { vhost: '/', queuePattern: ' ', depthAbove: 1 } })], /queuePattern must be a non-empty glob/);
    refuses([rule({ for: '5 minutes' })], /\.for must be a duration/);
    refuses([rule({ for: 300 })], /\.for must be a duration/);
    refuses([rule({ repeatEvery: '1x' })], /\.repeatEvery must be a duration/);
    refuses([rule({ when: { vhost: '/', queue: 'a', arrivalsAbove: { count: 1, within: 'soon' } } })], /within must be a duration/);
  });

  it('refuses a condition that is not exactly one, or queue and pattern together or neither', () => {
    refuses([rule({ when: { vhost: '/', queue: 'a' } })], /exactly one of depthAbove/);
    refuses([rule({ when: { vhost: '/', queue: 'a', depthAbove: 1, anyArrival: true } })], /exactly one of depthAbove/);
    refuses([rule({ when: { vhost: '/', depthAbove: 1 } })], /exactly one of queue and queuePattern/);
    refuses([rule({ when: { vhost: '/', queue: 'a', queuePattern: 'b', depthAbove: 1 } })], /exactly one of queue and queuePattern/);
  });

  it('refuses bad values and unknown keys', () => {
    refuses([rule({ when: { vhost: '/', queue: 'a', depthAbove: -1 } })], /depthAbove must be a whole number/);
    refuses([rule({ when: { vhost: '/', queue: 'a', anyArrival: false } })], /anyArrival must be true/);
    refuses([rule({ when: { vhost: 'other', queue: 'a', depthAbove: 1 } })], /vhost "other" is not one of the profile's vhosts/);
    refuses([rule({ extra: 1 })], /\.extra is not a key/);
    refuses([rule({ destinations: [] })], /non-empty list/);
    refuses('nope', /must be a list/);
  });
});
