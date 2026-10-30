// The profiles file's top-level `alertDestinations`: where notifications go.
// Every URL and signing secret comes from an environment variable, and a
// refusal names the place in the file without ever repeating a value.
import { describe, expect, it } from 'vitest';
import { parseProfilesFile } from '../../src/server/profiles.js';

const SLACK_URL = 'https://hooks.slack.example/services/T/B/secret-part';

const fileWith = (destinations: string[]) =>
  [
    'alertDestinations:',
    ...destinations,
    'profiles:',
    '  - name: prod',
    '    managementUrl: http://localhost:15672',
    '    amqpUrl: amqp://localhost:5672',
    '    username: guest',
    '    passwordEnv: PROD_PW',
  ].join('\n');

const env = { SLACK_URL, HOOK_URL: 'http://hook.example/in', HOOK_SECRET: 's3cret', TEAMS_URL: 'https://teams.example/flow' };
const parse = (destinations: string[], e: Record<string, string | undefined> = env) =>
  parseProfilesFile(fileWith(destinations), e, 'profiles.yaml').alertDestinations;

describe('alertDestinations', () => {
  it('has none when the file declares none', () => {
    const text = fileWith([]).replace('alertDestinations:\n', '');
    expect(parseProfilesFile(text, {}, 'profiles.yaml').alertDestinations).toEqual([]);
  });

  it('reads each type, resolving its URL and signing secret from the environment', () => {
    expect(
      parse([
        '  - { name: ops-slack, type: slack, urlEnv: SLACK_URL }',
        '  - { name: ops-teams, type: teams, urlEnv: TEAMS_URL }',
        '  - { name: pager, type: webhook, urlEnv: HOOK_URL, signingSecretEnv: HOOK_SECRET }',
        '  - { name: plain, type: webhook, urlEnv: HOOK_URL }',
      ]),
    ).toEqual([
      { name: 'ops-slack', type: 'slack', url: SLACK_URL, signingSecret: null },
      { name: 'ops-teams', type: 'teams', url: 'https://teams.example/flow', signingSecret: null },
      { name: 'pager', type: 'webhook', url: 'http://hook.example/in', signingSecret: 's3cret' },
      { name: 'plain', type: 'webhook', url: 'http://hook.example/in', signingSecret: null },
    ]);
  });

  it.each([
    [
      'an unset urlEnv',
      '  - { name: a, type: slack, urlEnv: NOPE }',
      'profiles.yaml: alertDestinations[0] ("a").urlEnv names NOPE, which is not set',
    ],
    [
      'an unset signingSecretEnv',
      '  - { name: a, type: webhook, urlEnv: HOOK_URL, signingSecretEnv: NOPE }',
      'profiles.yaml: alertDestinations[0] ("a").signingSecretEnv names NOPE, which is not set',
    ],
    [
      'a signingSecretEnv on a Slack destination',
      '  - { name: a, type: slack, urlEnv: SLACK_URL, signingSecretEnv: HOOK_SECRET }',
      'profiles.yaml: alertDestinations[0] ("a").signingSecretEnv is only allowed with type: webhook',
    ],
    [
      'a signingSecretEnv on a Teams destination',
      '  - { name: a, type: teams, urlEnv: TEAMS_URL, signingSecretEnv: HOOK_SECRET }',
      'profiles.yaml: alertDestinations[0] ("a").signingSecretEnv is only allowed with type: webhook',
    ],
    [
      'an unknown key',
      '  - { name: a, type: slack, urlEnv: SLACK_URL, url: "http://x" }',
      'profiles.yaml: alertDestinations[0] ("a").url is not a key of an Alert Destination',
    ],
    [
      'an unknown type',
      '  - { name: a, type: email, urlEnv: SLACK_URL }',
      'profiles.yaml: alertDestinations[0] ("a").type must be slack, teams or webhook',
    ],
    ['a missing name', '  - { type: slack, urlEnv: SLACK_URL }', 'profiles.yaml: alertDestinations[0].name is required'],
    [
      'a name that cannot go in a URL path',
      '  - { name: "a b", type: slack, urlEnv: SLACK_URL }',
      'profiles.yaml: alertDestinations[0].name "a b" may only contain letters, digits, - and _',
    ],
    [
      'a missing urlEnv',
      '  - { name: a, type: slack }',
      'profiles.yaml: alertDestinations[0] ("a").urlEnv is required',
    ],
    ['an entry that is not a mapping', '  - slack', 'profiles.yaml: alertDestinations[0] must be a mapping'],
  ])('refuses %s, naming the place in the file', (_case, line, message) => {
    expect(() => parse([line])).toThrow(message);
  });

  it('refuses a variable set to nothing, as unset', () => {
    expect(() => parse(['  - { name: a, type: slack, urlEnv: EMPTY }'], { EMPTY: '  ' })).toThrow(
      'alertDestinations[0] ("a").urlEnv names EMPTY, which is not set',
    );
  });

  it('refuses duplicate names', () => {
    expect(() =>
      parse(['  - { name: a, type: slack, urlEnv: SLACK_URL }', '  - { name: a, type: teams, urlEnv: TEAMS_URL }']),
    ).toThrow('profiles.yaml: alertDestinations[1] ("a").name is used by another Alert Destination');
  });

  it('refuses a list that is not a list', () => {
    expect(() => parseProfilesFile('alertDestinations: 3\nprofiles: [{}]', {}, 'profiles.yaml')).toThrow(
      'profiles.yaml: alertDestinations must be a list',
    );
  });

  it('refuses a variable that does not hold an http(s) URL, without repeating the value (it is a credential)', () => {
    for (const value of ['ftp://hooks.example/secret-part', 'secret-part']) {
      let message = '';
      try {
        parse(['  - { name: a, type: slack, urlEnv: BAD }'], { BAD: value });
      } catch (err) {
        message = (err as Error).message;
      }
      expect(message).toContain('alertDestinations[0] ("a").urlEnv: BAD must hold an http or https URL');
      expect(message).not.toContain('secret-part');
    }
  });
});
