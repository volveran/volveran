// The groups claim in the shapes real identity providers send it: a dotted
// path (Keycloak's `realm_access.roles`), a single string, or only in the
// userinfo answer. And the Operator it gives no role anywhere.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closedPort, startApp, testProfile, type TestApp } from './harness.js';
import { startUserinfoProvider, teamModeEnv, TestBrowser, type TestIdentity, type UserinfoProvider } from './oidc-provider.js';

const roles = { viewer: ['support'], operator: ['oncall'], admin: ['platform'] };

/** Starts a Team Mode app whose only profile, `prod`, has `roles`. */
async function startTeamApp(env: Record<string, string> = {}, issuer?: string, logs?: Array<Record<string, any>>) {
  const port = await closedPort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const app = await startApp({
    profiles: [testProfile({ name: 'prod', roles })],
    port,
    env: { ...teamModeEnv(baseUrl, issuer), ...env },
    logs,
  });
  const session = async (identity: TestIdentity) => {
    const browser = new TestBrowser(baseUrl);
    const signedIn = await browser.signIn(identity);
    expect(signedIn.status).toBe(302);
    expect(signedIn.location).toBe('/');
    return (await browser.get('/api/session')).body;
  };
  return { app, session };
}

describe('The groups claim', () => {
  describe('the default claim, `groups`', () => {
    let app: TestApp;
    let session: (identity: TestIdentity) => Promise<any>;
    const logs: Array<Record<string, any>> = [];
    beforeAll(async () => {
      ({ app, session } = await startTeamApp({}, undefined, logs));
    });
    afterAll(async () => {
      await app?.close();
    });

    it('counts a single string as a group', async () => {
      const s = await session({ sub: 'sol-sub', groups: 'oncall' });
      expect(s.groups).toEqual(['oncall']);
      expect(s.roles).toEqual({ prod: 'operator' });
    });

    it('gives no groups for a malformed claim, logs it, and still signs in', async () => {
      logs.length = 0;
      const s = await session({ sub: 'mal-sub', groups: { oncall: true } });
      expect(s).toMatchObject({ mode: 'team', operatorId: 'mal-sub', groups: [], roles: {} });
      const warning = logs.find((l) => l.claim === 'groups');
      expect(warning).toMatchObject({ level: 40, claim: 'groups', source: 'ID token', shape: 'an object' });
      expect(warning!.msg).toMatch(/not a list of group names/);
    });

    it('answers the session of an Operator with no role anywhere with their groups', async () => {
      const s = await session({ sub: 'nora-sub', email: 'nora@example.com', groups: ['marketing', 'sales'] });
      expect(s).toEqual({
        mode: 'team',
        operator: 'nora@example.com',
        operatorId: 'nora-sub',
        email: 'nora@example.com',
        checkoutId: null,
        roles: {},
        groups: ['marketing', 'sales'],
      });
    });
  });

  it('follows a dotted path such as realm_access.roles', async () => {
    const { app, session } = await startTeamApp({ VOLVERAN_OIDC_GROUPS_CLAIM: 'realm_access.roles' });
    try {
      const s = await session({ sub: 'kim-sub', realm_access: { roles: ['offline_access', 'platform'] } });
      expect(s.groups).toEqual(['offline_access', 'platform']);
      expect(s.roles).toEqual({ prod: 'admin' });
    } finally {
      await app.close();
    }
  });

  describe('from userinfo', () => {
    let provider: UserinfoProvider;
    let app: TestApp;
    let session: (identity: TestIdentity) => Promise<any>;
    beforeAll(async () => {
      provider = await startUserinfoProvider((sub) => (sub === 'uma-sub' ? { groups: ['support'] } : {}));
      ({ app, session } = await startTeamApp({}, provider.issuer));
    });
    afterAll(async () => {
      await app?.close();
      await provider?.close();
    });

    it('reads the groups from userinfo when the ID token lacks the claim', async () => {
      const s = await session({ sub: 'uma-sub' });
      expect(s.groups).toEqual(['support']);
      expect(s.roles).toEqual({ prod: 'viewer' });
    });

    it('prefers the ID token when it has the claim', async () => {
      const s = await session({ sub: 'uma-sub', groups: ['oncall'] });
      expect(s.groups).toEqual(['oncall']);
      expect(s.roles).toEqual({ prod: 'operator' });
    });
  });
});
