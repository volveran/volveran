// A Broker Profile's `roles`: which OIDC groups hold which Role on it.
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

const parse = (extra: string[]) => parseProfiles(profileWith(extra), {}, 'profiles.yaml');

describe('Broker Profile roles', () => {
  it('reads a mapping of roles to groups', () => {
    const [profile] = parse([
      '    roles:',
      '      viewer: [support]',
      '      operator: [oncall, sre]',
      '      admin: [platform]',
    ]);
    expect(profile!.roles).toEqual({ viewer: ['support'], operator: ['oncall', 'sre'], admin: ['platform'] });
  });

  it('accepts any of the roles on their own', () => {
    expect(parse(['    roles:', '      admin: [platform]'])[0]!.roles).toEqual({ admin: ['platform'] });
  });

  it('leaves `roles` out when the profile has none', () => {
    expect(parse([])[0]!.roles).toBeUndefined();
  });

  it('refuses a role that does not exist, naming the profile and the key', () => {
    expect(() => parse(['    roles:', '      owner: [platform]'])).toThrow(
      'profiles.yaml: profiles[0] ("prod").roles.owner is not a role; the roles are viewer, operator and admin',
    );
  });

  it('refuses an empty group list', () => {
    expect(() => parse(['    roles:', '      operator: []'])).toThrow(
      'profiles.yaml: profiles[0] ("prod").roles.operator must be a non-empty list of group names',
    );
  });

  it('refuses a group that is not a string', () => {
    expect(() => parse(['    roles:', '      viewer: [support, 42]'])).toThrow(
      'profiles.yaml: profiles[0] ("prod").roles.viewer must be a non-empty list of group names',
    );
    expect(() => parse(['    roles:', '      viewer: support'])).toThrow(/\("prod"\)\.roles\.viewer must be a non-empty list/);
    expect(() => parse(['    roles:', '      viewer: [""]'])).toThrow(/\("prod"\)\.roles\.viewer must be a non-empty list/);
  });

  it('refuses `roles` that is not a mapping, or an empty one', () => {
    expect(() => parse(['    roles: [admin]'])).toThrow(
      'profiles.yaml: profiles[0] ("prod").roles must be a mapping of viewer, operator or admin to lists of group names',
    );
    expect(() => parse(['    roles: {}'])).toThrow(/\("prod"\)\.roles must be a mapping/);
  });
});
