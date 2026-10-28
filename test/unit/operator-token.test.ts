// The Operator's access token refreshes itself a margin before it expires
// (60 seconds, or half its lifetime when shorter) and tells every live
// connection the new token. A refused refresh stops refreshing: the token
// runs out at its expiry, and the broker closes what it opened.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OperatorToken, RefreshRefused, type TokenGrant } from '../../src/server/operator-token.js';

const t0 = Date.UTC(2026, 9, 28, 12, 0, 0);

/** An unsigned JWT with these claims (the broker verifies signatures, not Volverán). */
const jwt = (claims: Record<string, unknown>) =>
  ['{"alg":"none"}', JSON.stringify(claims), ''].map((part) => Buffer.from(part).toString('base64url')).join('.');

/** A token for `sub` that expires `lifetimeSeconds` from now. */
const grant = (lifetimeSeconds: number, n = 0): TokenGrant => ({
  accessToken: jwt({ sub: 'rita', n, exp: Math.floor(Date.now() / 1000) + lifetimeSeconds }),
  expiresIn: lifetimeSeconds,
  refreshToken: `refresh-${n}`,
});

describe("The Operator's token", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(t0);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('refreshes 60 seconds before an hour-long token expires and pushes the new token to every listener', async () => {
    const refreshed: string[] = [];
    const refresh = vi.fn(async (refreshToken: string) => grant(3600, Number(refreshToken.split('-')[1]) + 1));
    const token = new OperatorToken(grant(3600), { refresh });
    const first = token.valid();
    token.onRefresh((accessToken) => refreshed.push(accessToken));

    await vi.advanceTimersByTimeAsync(3540_000 - 1);
    expect(refresh).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(refresh).toHaveBeenCalledWith('refresh-0');
    expect(refreshed).toEqual([token.valid()]);
    expect(token.valid()).not.toBe(first);
    expect(token.claims).toMatchObject({ n: 1 });
    expect(token.expiresAt).toBe(t0 + 3540_000 + 3600_000);

    // And again before the new token expires, with the rotated refresh token.
    await vi.advanceTimersByTimeAsync(3540_000);
    expect(refresh).toHaveBeenLastCalledWith('refresh-1');
    expect(refreshed).toHaveLength(2);
    token.stop();
  });

  it('refreshes halfway through a token that lasts less than two minutes', async () => {
    const refresh = vi.fn(async () => grant(10, 1));
    const token = new OperatorToken(grant(10), { refresh });
    await vi.advanceTimersByTimeAsync(4_999);
    expect(refresh).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(refresh).toHaveBeenCalledTimes(1);
    token.stop();
  });

  it('stops refreshing when the provider refuses, and the token runs out at its expiry', async () => {
    const failures: string[] = [];
    const refresh = vi.fn(async () => {
      throw new RefreshRefused('invalid_grant');
    });
    const token = new OperatorToken(grant(10), { refresh, onFailure: (reason) => failures.push(reason) });
    const listener = vi.fn();
    token.onRefresh(listener);

    await vi.advanceTimersByTimeAsync(5_000);
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(failures).toEqual(['invalid_grant']);
    expect(token.valid()).not.toBeNull();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(token.valid()).toBeNull();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(listener).not.toHaveBeenCalled();
  });

  it('tries again after a failure that may pass, while the token is still valid', async () => {
    let calls = 0;
    const refresh = vi.fn(async () => {
      if (++calls === 1) throw new Error('connect ECONNREFUSED');
      return grant(3600, 1);
    });
    const token = new OperatorToken(grant(3600), { refresh });
    await vi.advanceTimersByTimeAsync(3540_000);
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(token.claims).toMatchObject({ n: 0 });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(refresh).toHaveBeenCalledTimes(2);
    expect(token.claims).toMatchObject({ n: 1 });
    token.stop();
  });

  it('treats a refreshed token that expires no later than the old one as a refusal, so it does not refresh in a loop', async () => {
    const failures: string[] = [];
    const sameExp = grant(10);
    const refresh = vi.fn(async () => ({ ...sameExp, refreshToken: 'refresh-1' }));
    const token = new OperatorToken(sameExp, { refresh, onFailure: (reason) => failures.push(reason) });
    const listener = vi.fn();
    token.onRefresh(listener);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(listener).not.toHaveBeenCalled();
    expect(failures).toEqual([expect.stringMatching(/does not expire later/)]);
  });

  it('does not refresh without a refresh token, after stop(), or past the end of the session', async () => {
    const refresh = vi.fn(async () => grant(10, 1));
    new OperatorToken({ ...grant(10), refreshToken: undefined }, { refresh });
    new OperatorToken(grant(10), { refresh }).stop();
    new OperatorToken(grant(10), { refresh, until: t0 + 4_000 });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(refresh).not.toHaveBeenCalled();
  });

  it('stops telling a listener once it unsubscribes', async () => {
    const token = new OperatorToken(grant(10), { refresh: async () => grant(3600, 1) });
    const listener = vi.fn();
    token.onRefresh(listener)();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(listener).not.toHaveBeenCalled();
    token.stop();
  });

  it('is never serialised, so neither token reaches a log line or the browser', () => {
    const token = new OperatorToken(grant(3600), { refresh: async () => grant(3600, 1) });
    expect(JSON.stringify({ operator: { id: 'rita', brokerToken: token } })).toBe('{"operator":{"id":"rita"}}');
    token.stop();
  });
});
