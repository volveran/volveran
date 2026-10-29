// A Broker Profile's `replayRules`: each rule's declaration, its defaults,
// and the refusals at startup, which name the profile, the rule and the key.
import { describe, expect, it } from 'vitest';
import { checkReplayRules, parseProfiles } from '../../src/server/profiles.js';

const MINUTE = 60_000;

const RULE = [
  '      - name: db-timeouts',
  '        vhost: /',
  '        queue: orders.dlq',
  '        every: 5m',
  '        backoff: { initial: 1m, max: 1h }',
  '        maxAttempts: 5',
  '        stopWhen: { diedAgain: 10, within: 15m }',
];

const yamlWith = (profileExtra: string[], rules: string[][]) =>
  [
    'profiles:',
    '  - name: prod',
    '    managementUrl: http://localhost:15672',
    '    amqpUrl: amqp://localhost:5672',
    '    username: guest',
    '    passwordEnv: PROD_PW',
    ...profileExtra,
    ...(rules.length ? ['    replayRules:', ...rules.flat()] : []),
  ].join('\n');

const parse = (rules: string[][], profileExtra: string[] = []) =>
  parseProfiles(yamlWith(profileExtra, rules), {}, 'profiles.yaml')[0]!;
/** RULE with `key` replaced by `line` (or added), or left out when `line` is null. */
const ruleWith = (key: string, line: string | null) => {
  const lines = RULE.filter((l) => !l.trimStart().replace(/^- /, '').startsWith(`${key}:`));
  return line === null ? lines : [...lines, `        ${line}`];
};
const refusal = (rules: string[][], profileExtra: string[] = []) => {
  try {
    parse(rules, profileExtra);
  } catch (err) {
    return (err as Error).message;
  }
  throw new Error('expected a refusal');
};
const WHERE = 'profiles.yaml: profiles[0] ("prod").replayRules[0] ("db-timeouts")';

describe('Broker Profile replayRules', () => {
  it('has none by default', () => {
    expect(parse([]).replayRules).toEqual([]);
  });

  it('reads a rule with its defaults', () => {
    expect(parse([RULE]).replayRules).toEqual([
      {
        name: 'db-timeouts',
        vhost: '/',
        queue: 'orders.dlq',
        filter: null,
        everyMs: 5 * MINUTE,
        maxPerPass: 100,
        rate: 10,
        backoff: { initialMs: MINUTE, multiplier: 2, maxMs: 60 * MINUTE },
        maxAttempts: 5,
        whenAttemptsUsedUp: 'keep',
        stopWhen: { diedAgain: 10, withinMs: 15 * MINUTE },
        startPaused: false,
      },
    ]);
  });

  it('reads every key', () => {
    const rule = [
      '      - name: parked_2',
      '        vhost: shop',
      '        queue: payments.dlq',
      '        filter: { kind: x-death-reason, value: rejected }',
      '        every: 30s',
      '        maxPerPass: 20',
      '        rate: 2.5',
      '        backoff: { initial: 90s, multiplier: 1.5, max: 2h }',
      '        maxAttempts: 3',
      '        whenAttemptsUsedUp: { moveTo: { queue: payments.parked } }',
      '        stopWhen: { diedAgain: 4, within: 1h30m }',
      '        startPaused: true',
    ];
    expect(parse([rule]).replayRules[0]).toEqual({
      name: 'parked_2',
      vhost: 'shop',
      queue: 'payments.dlq',
      filter: [{ kind: 'x-death-reason', value: 'rejected' }],
      everyMs: 30_000,
      maxPerPass: 20,
      rate: 2.5,
      backoff: { initialMs: 90_000, multiplier: 1.5, maxMs: 120 * MINUTE },
      maxAttempts: 3,
      whenAttemptsUsedUp: { moveTo: { queue: 'payments.parked' } },
      stopWhen: { diedAgain: 4, withinMs: 90 * MINUTE },
      startPaused: true,
    });
  });

  it('takes a filter as a list of clauses too, as the API does', () => {
    const filter = ruleWith('filter', 'filter: [{ kind: routing-key, value: "orders.*" }, { kind: failure, value: Timeout }]');
    expect(parse([filter]).replayRules[0]!.filter).toEqual([
      { kind: 'routing-key', value: 'orders.*' },
      { kind: 'failure', value: 'Timeout' },
    ]);
  });

  it('caps the default rate at the profile replayRate.max', () => {
    expect(parse([RULE], ['    replayRate: { max: 4 }']).replayRules[0]!.rate).toBe(4);
  });

  it('refuses a rule that is not a mapping, and replayRules that is not a list', () => {
    expect(() => parse([['      - just-a-name']])).toThrow('profiles.yaml: profiles[0] ("prod").replayRules[0] must be a mapping');
    expect(() => parseProfiles(yamlWith(['    replayRules: yes'], []), {}, 'profiles.yaml')).toThrow(
      'profiles.yaml: profiles[0] ("prod").replayRules must be a list of rules',
    );
  });

  it('refuses a missing or malformed name, and a name used twice in the profile', () => {
    expect(refusal([['      - vhost: /', ...RULE.slice(2)]])).toBe(
      'profiles.yaml: profiles[0] ("prod").replayRules[0].name is required: letters, digits, - and _',
    );
    expect(refusal([['      - name: "db timeouts"', ...RULE.slice(1)]])).toBe(
      'profiles.yaml: profiles[0] ("prod").replayRules[0].name "db timeouts" may only contain letters, digits, - and _',
    );
    expect(refusal([RULE, RULE])).toBe('profiles.yaml: profiles[0] ("prod").replayRules[1] ("db-timeouts").name is used by another rule of this profile');
  });

  it('refuses an unknown key', () => {
    expect(refusal([ruleWith('queueName', 'queueName: orders.dlq')])).toBe(`${WHERE}.queueName is not a key of a Replay rule`);
  });

  it('refuses a missing vhost or queue, and a vhost the profile is not configured for', () => {
    expect(refusal([ruleWith('queue', null)])).toBe(`${WHERE}.queue is required and must be a non-empty string`);
    expect(refusal([ruleWith('vhost', null)])).toBe(`${WHERE}.vhost is required and must be a non-empty string`);
    expect(refusal([RULE], ['    vhosts: [shop]'])).toBe(`${WHERE}.vhost "/" is not one of the profile's vhosts`);
  });

  it('refuses an invalid filter', () => {
    expect(refusal([ruleWith('filter', 'filter: { kind: colour, value: red }')])).toMatch(new RegExp(`^${escape(WHERE)}\\.filter: `));
    expect(refusal([ruleWith('filter', 'filter: { kind: routing-key }')])).toBe(`${WHERE}.filter: The routing-key filter needs a "value".`);
  });

  it('refuses every out of range, or not a duration', () => {
    expect(refusal([ruleWith('every', 'every: 10s')])).toBe(`${WHERE}.every must be a duration from 30s to 24h`);
    expect(refusal([ruleWith('every', 'every: 25h')])).toBe(`${WHERE}.every must be a duration from 30s to 24h`);
    expect(refusal([ruleWith('every', 'every: soon')])).toBe(`${WHERE}.every must be a duration from 30s to 24h`);
    expect(refusal([ruleWith('every', 'every: 300')])).toBe(`${WHERE}.every must be a duration from 30s to 24h`);
    expect(refusal([ruleWith('every', null)])).toBe(`${WHERE}.every must be a duration from 30s to 24h`);
  });

  it('refuses maxPerPass out of range', () => {
    for (const v of ['0', '2.5', '"many"', '1000001']) {
      expect(refusal([ruleWith('maxPerPass', `maxPerPass: ${v}`)])).toMatch(`${WHERE}.maxPerPass must be a whole number from 1 to`);
    }
  });

  it('refuses a rate that is not a Replay Rate, or above the profile replayRate.max', () => {
    expect(refusal([ruleWith('rate', 'rate: 0')])).toBe(`${WHERE}.rate must be a number of Messages per second from 0.1 to 1000`);
    expect(refusal([ruleWith('rate', 'rate: 50')], ['    replayRate: { max: 20 }'])).toBe(
      `${WHERE}.rate (50) is above the profile's replayRate.max (20)`,
    );
  });

  it('refuses a back-off that is missing, out of range or shrinking', () => {
    expect(refusal([ruleWith('backoff', null)])).toBe(`${WHERE}.backoff is required: { initial, multiplier, max }`);
    expect(refusal([ruleWith('backoff', 'backoff: { initial: 1m }')])).toBe(`${WHERE}.backoff.max must be a duration from 1s to 7d`);
    expect(refusal([ruleWith('backoff', 'backoff: { initial: 0s, max: 1h }')])).toBe(`${WHERE}.backoff.initial must be a duration from 1s to 7d`);
    expect(refusal([ruleWith('backoff', 'backoff: { initial: 1m, multiplier: 0.5, max: 1h }')])).toBe(
      `${WHERE}.backoff.multiplier must be a number from 1 to 100`,
    );
    expect(refusal([ruleWith('backoff', 'backoff: { initial: 2h, max: 1h }')])).toBe(`${WHERE}.backoff.max (1h) is below backoff.initial (2h)`);
    expect(refusal([ruleWith('backoff', 'backoff: { initial: 1m, max: 1h, jitter: 5s }')])).toBe(
      `${WHERE}.backoff.jitter is not a key of backoff; it takes initial, multiplier and max`,
    );
  });

  it('refuses maxAttempts outside 1 to 100', () => {
    for (const v of ['0', '101', '1.5', 'null']) {
      expect(refusal([ruleWith('maxAttempts', `maxAttempts: ${v}`)])).toBe(`${WHERE}.maxAttempts must be a whole number from 1 to 100`);
    }
  });

  it('refuses an unknown whenAttemptsUsedUp, and a parking queue equal to the rule queue', () => {
    expect(refusal([ruleWith('whenAttemptsUsedUp', 'whenAttemptsUsedUp: discard')])).toBe(
      `${WHERE}.whenAttemptsUsedUp must be keep or { moveTo: { queue: <name> } }`,
    );
    expect(refusal([ruleWith('whenAttemptsUsedUp', 'whenAttemptsUsedUp: { moveTo: { queue: orders.dlq } }')])).toBe(
      `${WHERE}.whenAttemptsUsedUp.moveTo.queue must differ from the rule's queue "orders.dlq"`,
    );
  });

  it('refuses a rule without stopWhen, or with a malformed one', () => {
    expect(refusal([ruleWith('stopWhen', null)])).toBe(
      `${WHERE}.stopWhen is required: { diedAgain, within }, so the rule stops itself when its Replayed Messages die again`,
    );
    expect(refusal([ruleWith('stopWhen', 'stopWhen: { diedAgain: 0, within: 1h }')])).toBe(
      `${WHERE}.stopWhen.diedAgain must be a whole number from 1 to 100000`,
    );
    expect(refusal([ruleWith('stopWhen', 'stopWhen: { diedAgain: 3, within: forever }')])).toBe(
      `${WHERE}.stopWhen.within must be a duration from 1m to 7d`,
    );
  });

  it('refuses a startPaused that is not true or false', () => {
    expect(refusal([ruleWith('startPaused', 'startPaused: maybe')])).toBe(`${WHERE}.startPaused must be true or false`);
  });

  it('refuses a rule on a profile that connects with the Operator token', () => {
    const tokenProfile = [
      'profiles:',
      '  - name: prod',
      '    managementUrl: http://localhost:15672',
      '    amqpUrl: amqp://localhost:5672',
      '    credentials: operatorToken',
      '    replayRules:',
      ...RULE,
    ].join('\n');
    expect(() => parseProfiles(tokenProfile, {}, 'profiles.yaml')).toThrow(
      `${WHERE} is on a profile with credentials: operatorToken; a rule runs with no Operator signed in, so its profile needs username and passwordEnv`,
    );
  });
});

describe('checkReplayRules', () => {
  it("refuses a maxPerPass above the Checkout Message limit", () => {
    const profiles = parseProfiles(yamlWith([], [ruleWith('maxPerPass', 'maxPerPass: 600')]), {}, 'profiles.yaml');
    expect(() => checkReplayRules(profiles, { maxMessages: 500 })).toThrow(
      'Broker Profile "prod", Replay rule "db-timeouts": maxPerPass (600) is above the Checkout Message limit (500, VOLVERAN_CHECKOUT_MAX_MESSAGES)',
    );
    expect(() => checkReplayRules(profiles, { maxMessages: 600 })).not.toThrow();
  });
});

function escape(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
