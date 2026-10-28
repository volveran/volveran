// A Broker Profile's `credentials`: the shared service account (username and
// password from `passwordEnv`), or the signed-in Operator's own OAuth 2.0
// access token (`operatorToken`, Team Mode only), with the token claim the
// broker uses as the user name (`tokenUsernameClaim`).
import { describe, expect, it } from 'vitest';
import { checkProfilesForRunMode, parseProfiles } from '../../src/server/profiles.js';

const profileWith = (lines: string[]) =>
  [
    'profiles:',
    '  - name: prod',
    '    managementUrl: http://localhost:15672',
    '    amqpUrl: amqp://localhost:5672',
    ...lines,
  ].join('\n');

const shared = ['    username: guest', '    passwordEnv: PROD_PW'];
const parse = (lines: string[]) => parseProfiles(profileWith(lines), { PROD_PW: 'secret' }, 'profiles.yaml')[0]!;

describe('Broker Profile credentials', () => {
  it('defaults to the shared credentials of username and passwordEnv', () => {
    expect(parse(shared).credentials).toEqual({ kind: 'shared', username: 'guest', passwordEnv: 'PROD_PW', password: 'secret' });
    expect(parse([...shared, '    credentials: shared']).credentials.kind).toBe('shared');
  });

  it("connects with the Operator's token, the broker user from `sub` unless tokenUsernameClaim names another claim", () => {
    expect(parse(['    credentials: operatorToken']).credentials).toEqual({ kind: 'operatorToken', tokenUsernameClaim: 'sub' });
    expect(parse(['    credentials: operatorToken', '    tokenUsernameClaim: preferred_username']).credentials).toEqual({
      kind: 'operatorToken',
      tokenUsernameClaim: 'preferred_username',
    });
  });

  it('must be shared or operatorToken', () => {
    expect(() => parse([...shared, '    credentials: oauth'])).toThrow(
      'profiles.yaml: profiles[0] ("prod").credentials must be "shared" or "operatorToken", not "oauth"',
    );
  });

  it('refuses username or passwordEnv on an operatorToken profile, naming the profile and the key', () => {
    expect(() => parse(['    credentials: operatorToken', '    username: guest'])).toThrow(
      'profiles.yaml: profiles[0] ("prod").username is not allowed with credentials: operatorToken',
    );
    expect(() => parse(['    credentials: operatorToken', '    passwordEnv: PROD_PW'])).toThrow(
      'profiles.yaml: profiles[0] ("prod").passwordEnv is not allowed with credentials: operatorToken',
    );
  });

  it('refuses tokenUsernameClaim without credentials: operatorToken', () => {
    expect(() => parse([...shared, '    tokenUsernameClaim: preferred_username'])).toThrow(
      'profiles.yaml: profiles[0] ("prod").tokenUsernameClaim is only allowed with credentials: operatorToken',
    );
  });

  it('refuses a tokenUsernameClaim that is not a claim name', () => {
    expect(() => parse(['    credentials: operatorToken', '    tokenUsernameClaim: 42'])).toThrow(
      'profiles.yaml: profiles[0] ("prod").tokenUsernameClaim must be a non-empty string',
    );
  });

  it('still needs username and passwordEnv on a shared profile', () => {
    expect(() => parse(['    passwordEnv: PROD_PW'])).toThrow('profiles.yaml: profiles[0].username is required');
    expect(() => parse(['    username: guest'])).toThrow('profiles.yaml: profiles[0].passwordEnv is required');
  });

  it('refuses an operatorToken profile in Solo Mode, which has no signed-in Operator token', () => {
    const profiles = parseProfiles(profileWith(['    credentials: operatorToken']), {}, 'profiles.yaml');
    expect(() => checkProfilesForRunMode(profiles, 'solo')).toThrow(
      'Broker Profile "prod" has credentials: operatorToken, which needs Team Mode (VOLVERAN_AUTH=oidc)',
    );
    expect(() => checkProfilesForRunMode(profiles, 'team')).not.toThrow();
    expect(() => checkProfilesForRunMode(parseProfiles(profileWith(shared), {}), 'solo')).not.toThrow();
  });
});
