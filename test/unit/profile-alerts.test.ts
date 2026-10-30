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
    for (const pattern of ['^orders', 'orders$', 'a\\.dlq', '(a|b).dlq', 'a+.dlq', 'a|b', '[ab].dlq', 'a].dlq', 'a).dlq']) {
      refuses([rule({ when: { vhost: '/', queuePattern: pattern, depthAbove: 1 } })], /profiles\[0\] \("prod"\).*\.when\.queuePattern "[^"]+" looks like a regular expression/);
    }
    expect(parse([rule({ when: { vhost: '/', queuePattern: 'a.?-_*.dlq', depthAbove: 1 } })])).toHaveLength(1);
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

  describe('conditions on Volverán itself', () => {
    const replayRule = { name: 'retry', vhost: '/', queue: 'a.dlq', every: '5m', backoff: { initial: '10m', multiplier: 1, max: '10m' }, maxAttempts: 3, stopWhen: { diedAgain: 3, within: '1h' } };
    const withRules = { replayRules: [replayRule] };
    const when = (w: unknown, over: Record<string, unknown> = {}) => rule({ when: w, ...over });

    it('reads replayRulePaused, for any Replay Rule or a named one', () => {
      expect(parse([when({ replayRulePaused: true })], withRules)[0]!.when).toEqual({ kind: 'replayRulePaused', rule: null });
      expect(parse([when({ replayRulePaused: true, rule: 'retry' })], withRules)[0]!.when).toEqual({ kind: 'replayRulePaused', rule: 'retry' });
    });

    it('refuses a replayRulePaused naming an unknown Replay Rule, or on a profile with none', () => {
      refuses([when({ replayRulePaused: true, rule: 'nope' })], /\.when\.rule names "nope", which is not a Replay Rule of this profile/, withRules);
      refuses([when({ replayRulePaused: true })], /\.when\.replayRulePaused is on a profile with no Replay Rules/);
      refuses([when({ replayRulePaused: 'yes' })], /\.when\.replayRulePaused must be true/, withRules);
    });

    it('reads setupWarning and refuses another severity', () => {
      expect(parse([when({ setupWarning: 'may_lose_messages' })])[0]!.when).toEqual({ kind: 'setupWarning', severity: 'may_lose_messages' });
      refuses([when({ setupWarning: 'bad' })], /\.when\.setupWarning must be loses_messages or may_lose_messages/);
    });

    it('reads samplingFailing and refuses a malformed one', () => {
      expect(parse([when({ samplingFailing: { for: '10m' } })])[0]!.when).toEqual({ kind: 'samplingFailing', forMs: 600_000 });
      refuses([when({ samplingFailing: {} })], /\.when\.samplingFailing\.for must be a duration/);
      refuses([when({ samplingFailing: true })], /\.when\.samplingFailing must be a mapping with for/);
      refuses([when({ samplingFailing: { for: '10m', other: 1 } })], /\.when\.samplingFailing\.other is not a key/);
    });

    it('refuses the rule-level `for` on samplingFailing, which has its own', () => {
      refuses([when({ samplingFailing: { for: '10m' } }, { for: '5m' })], /\.for does not apply to samplingFailing/);
    });

    it('refuses keys that belong to another condition', () => {
      refuses([when({ setupWarning: 'loses_messages', vhost: '/' })], /\.when\.vhost does not apply to setupWarning/);
      refuses([when({ replayRulePaused: true, queue: 'a' })], /\.when\.queue does not apply to replayRulePaused/, withRules);
      refuses([when({ vhost: '/', queue: 'a', depthAbove: 1, rule: 'retry' })], /\.when\.rule does not apply to depthAbove/, withRules);
      refuses([when({ depthAbove: 1, setupWarning: 'loses_messages' })], /\.when must have exactly one of/);
    });

    it('refuses setupWarning and samplingFailing on an operatorToken profile, which is not sampled', () => {
      const tokens = { username: undefined, passwordEnv: undefined, credentials: 'operatorToken' };
      refuses([when({ setupWarning: 'loses_messages' })], /operatorToken/, tokens);
      refuses([when({ samplingFailing: { for: '10m' } })], /operatorToken/, tokens);
    });
  });
});
