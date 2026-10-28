// The Operator's groups at sign-in: VOLVERAN_OIDC_GROUPS_CLAIM as a dotted
// path into the ID token's claims, else the provider's userinfo.
import { describe, expect, it } from 'vitest';
import { groupsAtSignIn, type GroupsLog } from '../../src/server/groups-claim.js';

function recordingLog() {
  const lines: Array<{ fields: Record<string, unknown>; message: string }> = [];
  const log: GroupsLog = { warn: (fields, message) => lines.push({ fields, message }) };
  return { log, lines };
}

const read = async (idToken: Record<string, unknown>, claim: string, userinfo?: () => Promise<Record<string, unknown>>) => {
  const { log, lines } = recordingLog();
  const groups = await groupsAtSignIn({ idToken, claim, userinfo: userinfo ?? null, log });
  return { groups, lines };
};

describe('groups at sign-in', () => {
  it('reads a list of group names', async () => {
    expect((await read({ groups: ['support', 'oncall'] }, 'groups')).groups).toEqual(['support', 'oncall']);
  });

  it('drops empty and repeated names', async () => {
    expect((await read({ groups: ['support', '', 'support'] }, 'groups')).groups).toEqual(['support']);
  });

  it('follows a dotted path into nested claims', async () => {
    const claims = { realm_access: { roles: ['platform', 'offline_access'] } };
    expect((await read(claims, 'realm_access.roles')).groups).toEqual(['platform', 'offline_access']);
  });

  it('prefers a top-level claim whose name contains dots', async () => {
    const claims = { 'https://example.com/groups': ['support'], https: { '//example': { com: 'nope' } } };
    expect((await read(claims, 'https://example.com/groups')).groups).toEqual(['support']);
  });

  it('counts a single string as a list of one', async () => {
    const { groups, lines } = await read({ groups: 'support' }, 'groups');
    expect(groups).toEqual(['support']);
    expect(lines).toEqual([]);
  });

  it.each<[string, unknown]>([
    ['a number', 42],
    ['an object', { support: true }],
    ['null', null],
    ['a list with a non-string entry', ['support', 7]],
  ])('gives no groups and logs a warning for %s', async (_shape, value) => {
    const { groups, lines } = await read({ groups: value }, 'groups');
    expect(groups).toEqual([]);
    expect(lines).toHaveLength(1);
    expect(lines[0]!.fields).toMatchObject({ claim: 'groups', source: 'ID token' });
    expect(lines[0]!.message).toMatch(/groups claim "groups".*no groups/);
  });

  it('gives no groups for a path through a non-object, and logs it', async () => {
    const { groups, lines } = await read({ realm_access: 'x' }, 'realm_access.roles');
    expect(groups).toEqual([]);
    expect(lines).toHaveLength(1);
  });

  it('reads userinfo when the ID token lacks the claim', async () => {
    const { groups } = await read({ sub: 'x' }, 'groups', async () => ({ sub: 'x', groups: ['support'] }));
    expect(groups).toEqual(['support']);
  });

  it('does not read userinfo when the ID token has the claim', async () => {
    let asked = false;
    const userinfo = async () => {
      asked = true;
      return { groups: ['admin'] };
    };
    expect((await read({ groups: [] }, 'groups', userinfo)).groups).toEqual([]);
    expect((await read({ groups: 5 }, 'groups', userinfo)).groups).toEqual([]);
    expect(asked).toBe(false);
  });

  it('logs a malformed claim in userinfo with its source', async () => {
    const { groups, lines } = await read({}, 'groups', async () => ({ groups: { a: 1 } }));
    expect(groups).toEqual([]);
    expect(lines[0]!.fields).toMatchObject({ claim: 'groups', source: 'userinfo' });
  });

  it('gives no groups, and logs, when userinfo fails', async () => {
    const { groups, lines } = await read({}, 'groups', async () => {
      throw new Error('connection refused');
    });
    expect(groups).toEqual([]);
    expect(lines).toHaveLength(1);
    expect(lines[0]!.message).toMatch(/userinfo/);
  });

  it('gives no groups, silently, when neither the ID token nor userinfo has the claim', async () => {
    expect(await read({}, 'groups', async () => ({ sub: 'x' }))).toEqual({ groups: [], lines: [] });
    expect(await read({}, 'groups')).toEqual({ groups: [], lines: [] });
  });
});
