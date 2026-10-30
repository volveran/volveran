// What each Alert Destination type receives. A notification carries the
// profile, vhost, queue, condition, value, threshold, times and a link, and
// never anything of a Message.
import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { buildRequest, signWebhook, testNotification, type Notification } from '../../src/server/alerts/payloads.js';

const firing: Notification = {
  alertId: 'prod/deep/%2F/orders.dlq',
  status: 'firing',
  rule: 'deep',
  profile: 'prod',
  vhost: '/',
  queue: 'orders.dlq',
  condition: 'depthAbove',
  value: 500,
  threshold: 100,
  startedAt: '2026-10-30T10:00:00.000Z',
  endedAt: null,
  path: '/queues/orders.dlq',
};
const base = 'https://volveran.example.com';
const at = new Date('2026-10-30T10:05:00.000Z');
const slack = { name: 's', type: 'slack', url: 'https://x', signingSecret: null } as const;
const teams = { name: 't', type: 'teams', url: 'https://x', signingSecret: null } as const;
const webhook = { name: 'w', type: 'webhook', url: 'https://x', signingSecret: null } as const;
const built = (destination: Parameters<typeof buildRequest>[0], n: Notification = firing, publicUrl: string | null = base) =>
  buildRequest(destination, n, publicUrl, at);

describe('webhook body', () => {
  it('is the documented versioned JSON', () => {
    expect(JSON.parse(built(webhook).body)).toEqual({
      version: 1,
      test: false,
      alertId: 'prod/deep/%2F/orders.dlq',
      status: 'firing',
      rule: 'deep',
      profile: 'prod',
      vhost: '/',
      queue: 'orders.dlq',
      condition: 'depthAbove',
      value: 500,
      threshold: 100,
      replayRule: null,
      reason: null,
      startedAt: '2026-10-30T10:00:00.000Z',
      endedAt: null,
      url: 'https://volveran.example.com/queues/orders.dlq',
    });
  });

  it('names the Replay Rule and reason of a paused rule, in every type', () => {
    const paused: Notification = { ...firing, condition: 'replayRulePaused', vhost: null, queue: null, value: null, threshold: null, replayRule: 'retry', reason: 'died_again' };
    expect(JSON.parse(built(webhook, paused).body)).toMatchObject({ replayRule: 'retry', reason: 'died_again', queue: null });
    for (const destination of [slack, teams]) {
      expect(built(destination, paused).body).toContain('retry');
      expect(built(destination, paused).body).toContain('died_again');
    }
  });

  it('has no signature headers without a secret', () => {
    const { headers } = built(webhook);
    expect(headers).toEqual({ 'content-type': 'application/json' });
  });

  it('with a secret, carries the timestamp and the HMAC-SHA256 of "<timestamp>.<body>"', () => {
    const { headers, body } = built({ ...webhook, signingSecret: 'k' });
    expect(headers['x-volveran-timestamp']).toBe('1793354700');
    const expected = createHmac('sha256', 'k').update(`1793354700.${body}`).digest('hex');
    expect(headers['x-volveran-signature']).toBe(`sha256=${expected}`);
  });

  it('signs a known example the way the docs describe', () => {
    // Worked out apart from this code: Python's hmac over 1700000000.{"a":1} with the key "secret".
    expect(signWebhook('secret', '1700000000', '{"a":1}')).toBe(
      'sha256=49f24e537407743fa4a0242bb63b94b9a47ee99cbbe071ccd8a22550ae411686',
    );
  });
});

describe('Slack payload', () => {
  it('has a text fallback and Block Kit sections with the facts and the link', () => {
    const payload = JSON.parse(built(slack).body);
    expect(payload.text).toContain('Firing: deep');
    expect(payload.text).toContain('orders.dlq');
    expect(payload.blocks[0]).toEqual({ type: 'header', text: { type: 'plain_text', text: 'Firing: deep' } });
    const fields = payload.blocks[1].fields.map((f: { text: string }) => f.text);
    expect(fields).toEqual(
      expect.arrayContaining(['*Profile*\nprod', '*Vhost*\n/', '*Queue*\norders.dlq', '*Condition*\ndepthAbove', '*Value*\n500', '*Threshold*\n100']),
    );
    expect(payload.blocks.at(-1).text.text).toContain('<https://volveran.example.com/queues/orders.dlq|');
  });

  it("escapes Slack's control characters in names", () => {
    const payload = JSON.parse(built(slack, { ...firing, queue: 'a<b>&c' }).body);
    const fields = payload.blocks[1].fields.map((f: { text: string }) => f.text);
    expect(fields).toContain('*Queue*\na&lt;b&gt;&amp;c');
  });

  it('keeps the header within the 150 characters Slack accepts', () => {
    const payload = JSON.parse(built(slack, { ...firing, rule: 'r'.repeat(300) }).body);
    expect(payload.blocks[0].text.text.length).toBeLessThanOrEqual(150);
  });

  it('says it resolved, and when', () => {
    const payload = JSON.parse(built(slack, { ...firing, status: 'resolved', endedAt: '2026-10-30T11:00:00.000Z' }).body);
    expect(payload.blocks[0].text.text).toBe('Resolved: deep');
    expect(JSON.stringify(payload.blocks[1])).toContain('2026-10-30T11:00:00.000Z');
  });
});

describe('Teams payload', () => {
  it('is a workflow webhook message carrying an Adaptive Card with the facts and the link', () => {
    const payload = JSON.parse(built(teams).body);
    expect(payload.type).toBe('message');
    expect(payload.attachments).toHaveLength(1);
    expect(payload.attachments[0].contentType).toBe('application/vnd.microsoft.card.adaptive');
    const card = payload.attachments[0].content;
    expect(card.type).toBe('AdaptiveCard');
    expect(card.body[0]).toMatchObject({ type: 'TextBlock', text: 'Firing: deep' });
    expect(card.body.find((b: { type: string }) => b.type === 'FactSet').facts).toEqual(
      expect.arrayContaining([{ title: 'Queue', value: 'orders.dlq' }, { title: 'Threshold', value: '100' }]),
    );
    expect(card.actions).toEqual([
      { type: 'Action.OpenUrl', title: 'Open in Volverán', url: 'https://volveran.example.com/queues/orders.dlq' },
    ]);
  });
});

describe('links', () => {
  it('carries no link without a public URL', () => {
    expect(JSON.parse(built(webhook, firing, null).body).url).toBeNull();
    expect(built(slack, firing, null).body).not.toContain('Open in');
    expect(JSON.parse(built(teams, firing, null).body).attachments[0].content.actions).toEqual([]);
  });

  it('carries no link for a notification with no path', () => {
    expect(JSON.parse(built(webhook, { ...firing, path: null }).body).url).toBeNull();
  });
});

describe('test notifications', () => {
  const test = testNotification(at, 'test-id');

  it('are labelled in every type', () => {
    expect(JSON.parse(built(webhook, test).body)).toMatchObject({
      version: 1,
      test: true,
      alertId: 'test-id',
      rule: 'Test notification',
      profile: null,
      queue: null,
    });
    expect(JSON.parse(built(slack, test).body).text).toContain('Test notification');
    expect(built(slack, test).body).toContain('no Alert is firing');
    expect(built(teams, test).body).toContain('Test notification');
    expect(built(teams, test).body).toContain('no Alert is firing');
  });

  it('send Slack no empty fields, which it would refuse', () => {
    const blocks = JSON.parse(built(slack, test).body).blocks as Array<{ fields?: unknown[] }>;
    expect(blocks.every((b) => b.fields === undefined || b.fields.length > 0)).toBe(true);
  });
});

describe('Message content', () => {
  it('never reaches a payload, even if a caller passes it along', () => {
    const leaky = { ...firing, body: 'SECRET-BODY', headers: { h: 'SECRET-HEADER' }, message_id: 'SECRET-ID' } as Notification;
    for (const destination of [slack, teams, webhook]) {
      expect(built(destination, leaky).body).not.toContain('SECRET');
    }
  });
});
