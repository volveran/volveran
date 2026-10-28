// A Broker Profile's `requireApproval`: whether an Apply on a Protected
// Profile waits for a second Operator's Approval (Team Mode only).
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

describe('Broker Profile requireApproval', () => {
  it('defaults to true on a Protected Profile', () => {
    expect(parse(['    protected: true']).requireApproval).toBe(true);
  });

  it('can be turned off on a Protected Profile', () => {
    expect(parse(['    protected: true', '    requireApproval: false']).requireApproval).toBe(false);
    expect(parse(['    protected: true', '    requireApproval: true']).requireApproval).toBe(true);
  });

  it('is false on a profile that is not protected', () => {
    expect(parse([]).requireApproval).toBe(false);
    expect(parse(['    protected: false']).requireApproval).toBe(false);
  });

  it('is refused on a profile that is not protected, naming the profile and the key', () => {
    for (const extra of [['    requireApproval: true'], ['    protected: false', '    requireApproval: false']]) {
      expect(() => parse(extra)).toThrow(
        'profiles.yaml: profiles[0] ("prod").requireApproval is only allowed with protected: true',
      );
    }
  });

  it('must be true or false', () => {
    expect(() => parse(['    protected: true', '    requireApproval: "yes"'])).toThrow(
      'profiles.yaml: profiles[0] ("prod").requireApproval must be true or false',
    );
  });
});
