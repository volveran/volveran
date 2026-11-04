// Recording the read-only views for the demo (scripts/screenshots/demo-recording.mjs):
// what the screenshot run asks the real server, and what it keeps of the answers.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { hostValuesIn, recordDemo } from '../../scripts/screenshots/demo-recording.mjs';

const recordedAt = '2026-11-04T21:00:00.000Z';
const mgmt = 'http://127.0.0.1:49153';
const amqp = 'amqp://127.0.0.1:49154';
const webhook = 'http://127.0.0.1:18091/';

const profile = (name: string) => ({
  name,
  credentials: 'shared',
  username: 'volveran-admin',
  managementUrl: mgmt,
  amqpUrl: amqp,
  passwordEnv: 'VOLVERAN_TEST_PASSWORD',
  passwordSet: true,
  vhosts: 'all',
  defaultQueueFilter: '*.dlq',
  protected: name === 'production',
});

/** A server that answers the paths it knows, and fails on any other as the real one would. */
function fakeServer() {
  const asked: string[] = [];
  const answers: Record<string, unknown> = {
    '/profiles': { profiles: [profile('staging'), profile('production')] },
    '/alerts': {
      alerts: [],
      notifications: [{ id: 1, at: recordedAt, destination: 'ops-slack', error: `connect ECONNREFUSED ${webhook}` }],
      destinations: [{ name: 'ops-slack', type: 'webhook' }],
    },
  };
  for (const p of ['staging', 'production']) {
    answers[`/profiles/${p}/vhosts`] = { vhosts: [{ name: '/' }] };
    answers[`/profiles/${p}/alert-rules`] = { rules: [] };
    answers[`/profiles/${p}/replay-rules`] = { rules: [] };
    answers[`/profiles/${p}/vhosts/%2F/queues?search=&onlyDeadLetterQueues=false`] = {
      defaultQueueFilter: '*.dlq',
      queues: [{ name: 'orders.dlq', checkedOutBy: null }],
      setupWarningCounts: { loses_messages: 0, may_lose_messages: 0 },
    };
    answers[`/profiles/${p}/vhosts/%2F/dead-letter-map`] = { nodes: [] };
    answers[`/profiles/${p}/vhosts/%2F/move-destinations`] = { queues: ['orders.dlq'], exchanges: [] };
    for (const [range, from] of [
      ['1h', '2026-11-04T20:00:00.000Z'],
      ['24h', '2026-11-03T21:00:00.000Z'],
      ['7d', '2026-10-28T21:00:00.000Z'],
    ] as const) {
      answers[`/profiles/${p}/vhosts/%2F/queues/orders.dlq/history?${new URLSearchParams({ from, to: recordedAt })}`] = {
        range,
        marks: [{ operator: 'ana', checkoutId: 'c1' }],
      };
    }
  }
  return {
    asked,
    get: async (path: string) => {
      asked.push(path);
      if (!(path in answers)) throw new Error(`unexpected GET ${path}`);
      return structuredClone(answers[path]);
    },
  };
}

const options = {
  recordedAt,
  operator: 'ana',
  replace: [
    [mgmt, 'http://rabbitmq.example:15672'],
    [amqp, 'amqp://rabbitmq.example:5672'],
    [webhook, 'https://hooks.example.com/ops-slack'],
  ] as Array<[string, string]>,
};

describe('recording the read-only views for the demo', () => {
  it('asks every read-only view of both Broker Profiles, with each queue history over 1 hour, 24 hours and 7 days', async () => {
    const server = fakeServer();
    const recording = await recordDemo(server.get, options);
    expect(recording.recordedAt).toBe(recordedAt);
    expect(recording.profiles.map((p: { summary: { name: string } }) => p.summary.name)).toEqual(['staging', 'production']);
    const root = recording.profiles[1].vhosts[0];
    expect(root.name).toBe('/');
    expect(root.queueList.queues[0].name).toBe('orders.dlq');
    expect(root.deadLetterMap).toEqual({ nodes: [] });
    expect(root.moveDestinations).toEqual({ queues: ['orders.dlq'], exchanges: [] });
    expect(Object.keys(root.histories['orders.dlq'])).toEqual(['1h', '24h', '7d']);
    expect(root.histories['orders.dlq']['24h'].range).toBe('24h');
    expect(recording.profiles[0].alertRules).toEqual([]);
    expect(recording.profiles[0].replayRules).toEqual([]);
    expect(recording.alerts.destinations).toEqual([{ name: 'ops-slack', type: 'webhook' }]);
    expect(server.asked).toHaveLength(2 + 2 * (3 + 3 + 3));
  });

  it('keeps no host-specific value: broker addresses and the webhook are replaced, the Operator is demo', async () => {
    const recording = await recordDemo(fakeServer().get, options);
    const text = JSON.stringify(recording);
    expect(text).not.toContain('127.0.0.1');
    expect(recording.profiles[0].summary.managementUrl).toBe('http://rabbitmq.example:15672');
    expect(recording.profiles[0].summary.amqpUrl).toBe('amqp://rabbitmq.example:5672');
    expect(recording.alerts.notifications[0].error).toBe('connect ECONNREFUSED https://hooks.example.com/ops-slack');
    expect(recording.profiles[0].vhosts[0].histories['orders.dlq']['1h'].marks[0].operator).toBe('demo');
  });

  it('names what is still host-specific, so the run can refuse to write it', () => {
    expect(hostValuesIn({ a: 'http://localhost:8080/x', b: ['/var/folders/tmp.Xy/data/audit.sqlite', 'fine'], c: 'volveran-admin-pass' })).toEqual([
      'localhost',
      '/var/folders/',
      'volveran-admin-pass',
    ]);
    expect(hostValuesIn({ url: 'http://rabbitmq.example:15672' })).toEqual([]);
  });

  it('the committed recording holds both Broker Profiles and nothing host-specific: no port but the default ones, no path, no webhook URL', () => {
    const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
    const text = readFileSync(path.join(root, 'docs/demo/recording.json'), 'utf8');
    const committed = JSON.parse(text);
    expect(committed.profiles.map((p: { summary: { name: string } }) => p.summary.name)).toEqual(['staging', 'production']);
    expect(hostValuesIn(committed)).toEqual([]);
    expect([...new Set(text.match(/:\d{2,5}\b(?=[/"])/g))].sort()).toEqual([':15672', ':5672']);
    expect(text).not.toMatch(/https?:\/\/(?!rabbitmq\.example|hooks\.example\.com)/);
  });
});
