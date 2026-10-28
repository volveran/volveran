// docs/rabbitmq-behaviour.md, "OAuth 2.0 tokens". Runs against the second
// test broker, which has the OAuth 2.0 backend only and trusts the mock OIDC
// provider's signing key (test/broker/rabbitmq-oauth.conf). These facts are
// the go/no-go check for connecting with the Operator's own token.
import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { sleep } from '../broker/client.js';
import {
  claimsOf,
  connectWithToken,
  managementWithToken,
  refresh,
  signIn,
  updateSecret,
  type TokenConnection,
} from '../broker/oauth.js';

/** A user name no other test signs in as. */
const user = (prefix: string) => `${prefix}-${randomBytes(3).toString('hex')}`;

/** Declares a server-named exclusive queue, publishes to it and gets the Message back: the connection works. */
async function roundTrip(tc: TokenConnection): Promise<string> {
  const ch = await tc.conn.createChannel();
  ch.on('error', () => {});
  const { queue } = await ch.assertQueue('', { exclusive: true });
  ch.sendToQueue(queue, Buffer.from('ping'));
  const deadline = Date.now() + 2_000;
  for (;;) {
    const m = await ch.get(queue, { noAck: true });
    if (m) {
      await ch.close();
      return m.content.toString();
    }
    if (Date.now() > deadline) throw new Error('the Message did not come back');
    await sleep(25);
  }
}

describe('OAuth 2.0 tokens', () => {
  describe('A connection opened with a valid access token as its password works. The broker user is the token\'s `sub`, whatever user name the client sends. An invalid token is refused at connection open.', () => {
    it('opens, declares, publishes and gets with the token\'s scopes, as the token\'s sub', async () => {
      const sub = user('alice');
      const tokens = await signIn(sub);
      const name = `facts-oauth-${sub}`;
      const tc = await connectWithToken(tokens.accessToken, { username: 'someone-else', connectionName: name });
      try {
        expect(await roundTrip(tc)).toBe('ping');
        const { status, body } = await managementWithToken('/connections', tokens.accessToken);
        expect(status).toBe(200);
        // Management statistics lag (docs "Queue counts"), so wait for the connection to be listed.
        let listed = (body as Array<{ user: string; client_properties?: { connection_name?: string } }>).find(
          (c) => c.client_properties?.connection_name === name,
        );
        for (let i = 0; !listed && i < 40; i++) {
          await sleep(250);
          const again = await managementWithToken('/connections', tokens.accessToken);
          listed = again.body.find((c: any) => c.client_properties?.connection_name === name);
        }
        expect(listed?.user).toBe(sub);
      } finally {
        await tc.conn.close().catch(() => {});
      }
    });

    it('refuses a token with a bad signature at connection open', async () => {
      const { accessToken } = await signIn(user('alice'));
      const forged = accessToken.slice(0, accessToken.lastIndexOf('.') + 1) + Buffer.from('forged').toString('base64url');
      await expect(connectWithToken(forged)).rejects.toThrow(/ACCESS_REFUSED|403/);
    });
  });

  describe('`update-secret` with a refreshed access token for the same user is accepted, and the connection then outlives the old token\'s expiry.', () => {
    it('accepts the token of a refresh grant and keeps the connection open past the old expiry', async () => {
      const sub = user('alice');
      const tokens = await signIn(sub, { expiresInSeconds: 4 });
      const oldExp = claimsOf(tokens.accessToken).exp as number;
      const tc = await connectWithToken(tokens.accessToken);
      try {
        // The mock provider's refresh grant copies every claim, `exp` too, so
        // the refresh is of a second sign-in of the same user with the
        // provider's default hour.
        const refreshed = await refresh(await signIn(sub));
        expect(refreshed.accessToken).not.toBe(tokens.accessToken);
        expect(claimsOf(refreshed.accessToken)).toMatchObject({ sub });
        expect(claimsOf(refreshed.accessToken).exp).toBeGreaterThan(oldExp + 60);

        expect(await updateSecret(tc, refreshed.accessToken)).toBe('accepted');

        await sleep(oldExp * 1000 - Date.now() + 2_000);
        expect(tc.closedAt()).toBeUndefined();
        expect(await roundTrip(tc)).toBe('ping');
      } finally {
        await tc.conn.close().catch(() => {});
      }
    });
  });

  describe('`update-secret` with an invalid token, an expired token or another user\'s token is refused: the broker closes the whole connection with `530 NOT_ALLOWED`.', () => {
    const cases: Array<{ kind: string; secret: (sub: string, valid: string) => Promise<string>; reason: RegExp }> = [
      { kind: 'a value that is not a token', secret: async () => 'not-a-token', reason: /Secret update failed/ },
      {
        kind: 'a token with a bad signature',
        secret: async (_sub, valid) => valid.slice(0, valid.lastIndexOf('.') + 1) + Buffer.from('forged').toString('base64url'),
        reason: /New secret was refused by one of the backends/,
      },
      {
        kind: 'an expired token of the same user',
        secret: async (sub) => (await signIn(sub, { expiresInSeconds: -60 })).accessToken,
        reason: /Provided JWT token has expired/,
      },
      {
        kind: 'a valid token of another user',
        secret: async () => (await signIn(user('bob'))).accessToken,
        reason: /New secret was refused by one of the backends/,
      },
    ];

    it.each(cases)('refuses $kind by closing the connection', async ({ secret, reason }) => {
      const sub = user('alice');
      const tokens = await signIn(sub);
      const tc = await connectWithToken(tokens.accessToken);
      const ch = await tc.conn.createChannel();
      ch.on('error', () => {});

      const result = await updateSecret(tc, await secret(sub, tokens.accessToken));

      expect(result).toBeInstanceOf(Error);
      expect((result as Error).message).toMatch(/^Connection closed: 530 \(NOT-ALLOWED\)/);
      expect((result as Error).message).toMatch(reason);
      await expect(ch.checkQueue('amq.rabbitmq.reply-to')).rejects.toThrow();
    });
  });

  describe('A connection whose token expires without a refresh is closed by the broker at the token\'s expiry, with `320 CONNECTION_FORCED` "credential expired".', () => {
    it('closes the connection when exp passes', async () => {
      const tokens = await signIn(user('alice'), { expiresInSeconds: 3 });
      const exp = (claimsOf(tokens.accessToken).exp as number) * 1000;
      const tc = await connectWithToken(tokens.accessToken);
      expect(await roundTrip(tc)).toBe('ping');

      const err = await Promise.race([tc.closed, sleep(10_000).then(() => 'still open' as const)]);

      expect(err).toBeInstanceOf(Error);
      expect((err as Error).message).toMatch(/^Connection closed: 320 \(CONNECTION-FORCED\) with message "CONNECTION_FORCED - credential expired"/);
      // exp has whole-second precision.
      expect(tc.closedAt()!).toBeGreaterThanOrEqual(exp - 1_000);
      expect(tc.closedAt()!).toBeLessThan(exp + 3_000);
    });
  });

  describe('The management API accepts the access token as a bearer token, and refuses an expired one with 401.', () => {
    it('answers /api/whoami for the token\'s sub', async () => {
      const sub = user('alice');
      const { accessToken } = await signIn(sub);
      const res = await managementWithToken('/whoami', accessToken);
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ name: sub, tags: ['management'], is_internal_user: false });
      expect((await managementWithToken('/overview', accessToken)).status).toBe(200);
    });

    it('refuses an expired token', async () => {
      const { accessToken } = await signIn(user('alice'), { expiresInSeconds: -60 });
      const res = await managementWithToken('/whoami', accessToken);
      expect(res.status).toBe(401);
    });
  });
});
