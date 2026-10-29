// Replay Rules through the HTTP API, against the real broker: a rule
// declared in the profiles file, and an `admin` running one Rule Pass on
// demand. The pass takes an ordinary Checkout as the rule, Replays the
// matching Messages that are due, Keeps the rest in order, and ends; every
// Replay is an Audit Entry naming the rule.
import type * as amqp from 'amqplib';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  closedPort,
  eventually,
  purgeQueues,
  startApp,
  testOperator,
  testProfile,
  withChannel,
  type TestApp,
} from './harness.js';
import { teamModeEnv, TestBrowser } from './oidc-provider.js';

// A quorum dead-letter queue (delivery-limit 5), dead-lettered from payments.work.
const dlq = 'payments.dlq';
const workQueue = 'payments.work';
const RULE_NAME = 'transient-payments';
const runPath = `/api/profiles/local/replay-rules/${RULE_NAME}/run`;
const checkoutPath = `/api/profiles/local/vhosts/%2F/queues/${dlq}/checkouts`;

const rule = {
  name: RULE_NAME,
  vhost: '/',
  queue: dlq,
  filter: { kind: 'header', name: 'transient' },
  every: '5m',
  backoff: { initial: '10m', max: '1h' },
  maxAttempts: 1,
  stopWhen: { diedAgain: 5, within: '15m' },
};

const HOUR = 3_600_000;

/** Puts a Message straight into the dead-letter queue, with an x-death entry `ageMs` old (null: none). */
async function deadLettered(
  messages: Array<{ id: string; ageMs: number; transient?: boolean; replayId?: string }>,
): Promise<void> {
  await withChannel('/', async (ch) => {
    for (const m of messages) {
      const time = { '!': 'timestamp', value: Math.floor((Date.now() - m.ageMs) / 1000) };
      ch.sendToQueue(dlq, Buffer.from(`payment ${m.id}`), {
        messageId: m.id,
        persistent: true,
        headers: {
          ...(m.transient && { transient: 'yes' }),
          ...(m.replayId && { 'x-volveran-replay-id': m.replayId }),
          'x-death': [
            { queue: workQueue, reason: 'rejected', count: 1, time, exchange: 'payments', 'routing-keys': ['payments.captured'] },
          ],
        },
      });
    }
    await ch.waitForConfirms();
  });
}

/** Every ready Message of `queue` in order (taken and put back with nack), with its x-delivery-count. */
async function readyMessages(queue: string): Promise<Array<{ id: string; deliveryCount: unknown }>> {
  return withChannel('/', async (ch) => {
    const taken: amqp.GetMessage[] = [];
    for (;;) {
      const m = await ch.get(queue, { noAck: false });
      if (!m) break;
      taken.push(m);
    }
    for (const m of taken) ch.nack(m, false, true);
    await ch.checkQueue(queue);
    return taken.map((m) => ({ id: String(m.properties.messageId), deliveryCount: m.properties.headers?.['x-delivery-count'] }));
  });
}

const ids = (messages: Array<{ id: string }>) => messages.map((m) => m.id);

describe('Replay rules', () => {
  let app: TestApp;
  /** Lets a held step of the rule's Apply go on; set while a test holds one. */
  let releaseStep: (() => void) | null = null;
  let holdSteps = false;
  let stepHeld: (() => void) | null = null;

  beforeAll(async () => {
    app = await startApp({
      profiles: [testProfile({ name: 'local', replayRules: [rule] })],
      checkoutTestHooks: {
        beforeApplyStep: async () => {
          if (!holdSteps) return;
          stepHeld?.();
          await new Promise<void>((resolve) => (releaseStep = resolve));
        },
      },
    });
  });
  afterEach(async () => {
    holdSteps = false;
    releaseStep?.();
    await purgeQueues('/', [dlq, workQueue]);
  });
  afterAll(async () => {
    await app?.close();
  });

  it('lists each rule with its declaration, its state, no pass before one has run, and its next pass', async () => {
    const res = await app.get('/api/profiles/local/replay-rules');
    expect(res.status).toBe(200);
    expect(res.body.rules).toEqual([
      {
        rule: {
          name: RULE_NAME,
          vhost: '/',
          queue: dlq,
          filter: [{ kind: 'header', name: 'transient' }],
          everyMs: 300_000,
          maxPerPass: 100,
          rate: 10,
          backoff: { initialMs: 600_000, multiplier: 2, maxMs: HOUR },
          maxAttempts: 1,
          whenAttemptsUsedUp: 'keep',
          stopWhen: { diedAgain: 5, withinMs: 900_000 },
          startPaused: false,
        },
        state: { paused: false, pausedReason: null, pausedBy: null, pausedAt: null },
        passes: [],
        nextPassAt: expect.any(String),
      },
    ]);
    expect((await app.get('/api/profiles/nowhere/replay-rules')).status).toBe(404);
  });

  it('Replays only the matching, due Messages and Keeps the rest in order, with no Delivery Budget used', async () => {
    await deadLettered([
      { id: 'due-1', ageMs: HOUR, transient: true },
      { id: 'no-match', ageMs: HOUR },
      { id: 'not-due', ageMs: 0, transient: true },
      { id: 'used-up', ageMs: HOUR, transient: true, replayId: 'sent-by-another-instance' },
      { id: 'due-2', ageMs: HOUR, transient: true },
    ]);
    const before = await readyMessages(dlq);

    const res = await app.post(runPath);

    expect(res.status).toBe(200);
    expect(res.body.pass).toMatchObject({
      status: 'ran',
      summary: { held: 5, replayed: 2, moved: 0, usedUp: 1, notDue: 1, noMatch: 1, failed: 0 },
    });
    // Kept in order, and on the quorum queue x-delivery-count is unchanged.
    expect(await readyMessages(dlq)).toEqual(before.filter((m) => !m.id.startsWith('due-')));
    expect(ids(await readyMessages(workQueue))).toEqual(['due-1', 'due-2']);
    // The queue is free again.
    const after = await app.post(checkoutPath);
    expect(after.status).toBe(201);
    await app.delete(`/api/checkouts/${after.body.checkout.id}`);

    const listed = (await app.get('/api/profiles/local/replay-rules')).body.rules[0];
    expect(listed.passes[0]).toEqual(res.body.pass);
  });

  it('records each Replay as an Audit Entry naming the rule, which the rule filter finds', async () => {
    await deadLettered([
      { id: 'audited-1', ageMs: HOUR, transient: true },
      { id: 'audited-2', ageMs: HOUR, transient: true },
    ]);
    const { pass } = (await app.post(runPath)).body;

    const entries = (await app.get(`/api/audit-entries?rule=${RULE_NAME}`)).body.entries as any[];
    const mine = entries.filter((e) => e.rulePassId === pass.id);
    expect(mine.map((e) => e.messageId).sort()).toEqual(['audited-1', 'audited-2']);
    for (const e of mine) {
      expect(e).toMatchObject({
        action: 'replay',
        outcome: 'done',
        operatorId: `rule:local/${RULE_NAME}`,
        operatorName: `Replay rule ${RULE_NAME}`,
        role: 'operator',
        approverId: null,
        brokerUser: 'volveran-admin',
        rule: RULE_NAME,
        rate: 10,
        destination: { queue: workQueue },
      });
      expect(e.message.headers.transient).toBe('yes');
    }
    expect((await app.get('/api/audit-entries?rule=another-rule')).body.entries).toEqual([]);
  });

  it('answers 409 with the holder while an Operator holds the queue, and touches nothing', async () => {
    await deadLettered([{ id: 'held-by-person', ageMs: HOUR, transient: true }]);
    const started = await app.post(checkoutPath);
    expect(started.status).toBe(201);

    const res = await app.post(runPath);

    expect(res.status).toBe(409);
    expect(res.body.error).toMatchObject({ code: 'checkout_in_progress', holder: { operator: testOperator } });
    await app.delete(`/api/checkouts/${started.body.checkout.id}`);
    expect(ids(await readyMessages(dlq))).toEqual(['held-by-person']);
  });

  it('refuses an Operator Checkout during a pass with "held by Replay rule", and the queue list names the rule', async () => {
    await deadLettered([{ id: 'in-pass', ageMs: HOUR, transient: true }]);
    holdSteps = true;
    const held = new Promise<void>((resolve) => (stepHeld = resolve));
    const running = app.post(runPath);
    await held;

    const refused = await app.post(checkoutPath);
    expect(refused.status).toBe(409);
    expect(refused.body.error).toMatchObject({ code: 'checkout_in_progress', holder: { operator: `Replay rule ${RULE_NAME}` } });
    expect(refused.body.error.message).toContain(`Replay rule ${RULE_NAME} has held it since`);
    await eventually(async () => {
      const { queues } = (await app.get('/api/profiles/local/vhosts/%2F/queues')).body;
      expect(queues.find((q: any) => q.name === dlq).checkedOutBy).toMatchObject({ operator: `Replay rule ${RULE_NAME}` });
    });

    releaseStep!();
    expect((await running).body.pass.summary).toMatchObject({ held: 1, replayed: 1 });
  });

  it('allows a rule on a Protected Profile, saying so in one startup log line', async () => {
    const logs: Array<Record<string, any>> = [];
    const other = await startApp({ profiles: [testProfile({ name: 'prod', protected: true, replayRules: [rule] })], logs });
    await other.close();
    const lines = logs.filter((l) => l.rule === RULE_NAME);
    expect(lines).toHaveLength(1);
    expect(lines[0]!.msg).toContain(`Replay rule "${RULE_NAME}" on Protected Profile "prod" Replays without Approval`);
  });

  it('answers 404 for a rule the profile does not declare', async () => {
    const res = await app.post('/api/profiles/local/replay-rules/no-such-rule/run');
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('replay_rule_not_found');
  });
});

describe('Replay rules and roles', () => {
  let app: TestApp;
  let baseUrl: string;
  const vera = { sub: 'vera-sub', email: 'vera@example.com', groups: ['support'] };
  const otto = { sub: 'otto-sub', email: 'otto@example.com', groups: ['oncall'] };

  async function signedIn(identity: typeof vera) {
    const browser = new TestBrowser(baseUrl);
    await browser.signIn(identity);
    return browser;
  }

  beforeAll(async () => {
    const port = await closedPort();
    baseUrl = `http://127.0.0.1:${port}`;
    app = await startApp({
      profiles: [
        testProfile({
          name: 'local',
          roles: { viewer: ['support'], operator: ['oncall'], admin: ['platform'] },
          replayRules: [rule],
        }),
      ],
      port,
      env: teamModeEnv(baseUrl),
    });
  });
  afterAll(async () => {
    await app?.close();
  });

  it('lets a viewer list the rules, but neither a viewer nor an `operator` Run now', async () => {
    const viewer = await signedIn(vera);
    expect((await viewer.get('/api/profiles/local/replay-rules')).body.rules).toHaveLength(1);
    expect((await viewer.post(runPath)).body.error).toMatchObject({ code: 'role_required', required: 'admin', held: 'viewer' });
    const operator = await signedIn(otto);
    const refused = await operator.post(runPath);
    expect(refused.status).toBe(403);
    expect(refused.body.error).toMatchObject({ code: 'role_required', required: 'admin', held: 'operator' });
  });
});
