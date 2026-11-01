// Which of the web app's requests say they were sent on its own, so that they do not count
// as the Operator's activity for the session idle timeout (auth.ts).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from '../../src/web/api.js';

const sentOnItsOwn = () => {
  const [, init] = vi.mocked(fetch).mock.lastCall!;
  return (init!.headers as Record<string, string>)['x-volveran-background'] === '1';
};

describe('requests the web app sends on its own', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ approvals: [], checkout: {} })));
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('marks the polling of the Approvals page', async () => {
    await api.approvals();
    expect(sentOnItsOwn()).toBe(true);
    await api.watchApprovalCheckout('c-1');
    expect(sentOnItsOwn()).toBe(true);
  });

  it('marks the heartbeat of a Checkout that is over, and not of one still going', async () => {
    await api.heartbeat('c-1');
    expect(sentOnItsOwn()).toBe(false);
    await api.heartbeat('c-1', { over: true });
    expect(sentOnItsOwn()).toBe(true);
  });

  it('leaves what the Operator asks for unmarked', async () => {
    await api.approvalCheckout('c-1');
    expect(sentOnItsOwn()).toBe(false);
  });
});
