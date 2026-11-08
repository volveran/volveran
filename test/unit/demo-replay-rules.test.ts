// The demo's Replay rules: the recorded rules of staging, which the Operator
// demo (admin) can pause and resume as on the server. A Rule Pass is not
// simulated, so Run now says it is not in the demo.
import { describe, expect, it } from 'vitest';
import { createDemoApi, type DemoApi } from '../../site/demo/api/demo-api.js';
import { startingState } from '../../site/demo/api/state.js';
import { committedRecording } from '../support/demo-recording.js';

const origin = 'https://volveran.github.io';
const now = Date.parse('2027-03-01T12:00:00.000Z');

async function call(api: DemoApi, method: string, path: string, body?: unknown) {
  const init: RequestInit = { method, ...(body !== undefined && { body: JSON.stringify(body), headers: { 'content-type': 'application/json' } }) };
  const res = await api.handle(new Request(`${origin}/api/v1${path}`, init));
  return { status: res.status, body: (await res.json()) as Record<string, any> };
}

const demoApi = () => createDemoApi(startingState(committedRecording, new Date(now)), () => now);
const rule = async (api: DemoApi, name: string) => (await call(api, 'GET', '/profiles/staging/replay-rules')).body.rules.find((r: any) => r.rule.name === name);

describe('a Replay rule in the demo', () => {
  it('pauses with a reason, by the Operator demo, with no next pass and an Audit Entry', async () => {
    const api = demoApi();
    const paused = await call(api, 'POST', '/profiles/staging/replay-rules/db-timeouts/pause', { reason: 'Database still down' });
    expect(paused.status).toBe(200);
    expect(paused.body.state).toEqual({ paused: true, pausedReason: 'Database still down', pausedBy: 'demo', pausedAt: expect.any(String) });
    expect(await rule(api, 'db-timeouts')).toMatchObject({ state: paused.body.state, nextPassAt: null });
    const [entry] = (await call(api, 'GET', '/audit-entries?action=rule_pause')).body.entries;
    expect(entry).toMatchObject({ action: 'rule_pause', rule: 'db-timeouts', reason: 'Database still down', operatorName: 'demo', profile: 'staging', queue: 'orders.dlq', outcome: 'done', message: null });
  });

  it('refuses a pause without a reason, and of a paused rule, as the server does', async () => {
    const api = demoApi();
    expect((await call(api, 'POST', '/profiles/staging/replay-rules/db-timeouts/pause', { reason: ' ' })).body.error.code).toBe('invalid_request');
    expect(await call(api, 'POST', '/profiles/staging/replay-rules/payment-gateway-503/pause', { reason: 'x' })).toMatchObject({
      status: 409,
      body: { error: { code: 'replay_rule_paused' } },
    });
    expect(await call(api, 'POST', '/profiles/staging/replay-rules/nope/pause', { reason: 'x' })).toMatchObject({
      status: 404,
      body: { error: { code: 'replay_rule_not_found' } },
    });
  });

  it('resumes a paused rule, which schedules its next pass, and refuses to resume a running one', async () => {
    const api = demoApi();
    const resumed = await call(api, 'POST', '/profiles/staging/replay-rules/payment-gateway-503/resume');
    expect(resumed).toEqual({ status: 200, body: { state: { paused: false, pausedReason: null, pausedBy: null, pausedAt: null } } });
    const view = await rule(api, 'payment-gateway-503');
    expect(Date.parse(view.nextPassAt)).toBe(now + view.rule.everyMs);
    expect((await call(api, 'GET', '/audit-entries?action=rule_resume')).body.entries).toHaveLength(1);
    expect(await call(api, 'POST', '/profiles/staging/replay-rules/db-timeouts/resume')).toMatchObject({
      status: 409,
      body: { error: { code: 'replay_rule_running' } },
    });
  });

  it('says Run now is not in the demo, and lists it so', async () => {
    const api = demoApi();
    expect(await call(api, 'POST', '/profiles/staging/replay-rules/db-timeouts/run')).toMatchObject({ status: 404, body: { error: { code: 'not_in_demo' } } });
    expect(api.routes().notInDemo).toContain('POST /api/v1/profiles/{profile}/replay-rules/{name}/run');
    expect(api.routes().handled).toEqual(
      expect.arrayContaining(['POST /api/v1/profiles/{profile}/replay-rules/{name}/pause', 'POST /api/v1/profiles/{profile}/replay-rules/{name}/resume']),
    );
  });
});
