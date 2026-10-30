// What each Alert Destination type receives, built from one Notification. A
// payload is made of the Notification's named fields only, so nothing else a
// caller holds can reach a chat tool: never a Message body, header or
// `message_id` (ADR 0012).
import { createHmac } from 'node:crypto';
import type { AlertDestinationType, NotificationStatus } from '../../shared/alerts.js';

/** One thing to tell an Alert Destination: an Alert firing or resolved, or a test. */
export interface Notification {
  /** Stable across an Alert's firing, repeats and resolved, so your service can deduplicate and pair them. */
  alertId: string;
  status: NotificationStatus;
  rule: string;
  /** Null only on a test notification. */
  profile: string | null;
  /** Null when the condition is not about a queue. */
  vhost: string | null;
  queue: string | null;
  condition: string;
  value: number | string | null;
  threshold: number | null;
  /** ISO 8601. */
  startedAt: string;
  endedAt: string | null;
  /** Where in Volverán to look, from the root (`/...`); null for no link. VOLVERAN_PUBLIC_URL goes in front. */
  path: string | null;
  /** The Replay Rule of a replayRulePaused Alert. */
  replayRule?: string | null;
  /** Why the condition holds: a pause's reason, set-up warning codes or a sampling error code. */
  reason?: string | null;
  /** A test notification, not an Alert. */
  test?: boolean;
}

export interface PayloadTarget {
  type: AlertDestinationType;
  signingSecret: string | null;
}

export interface NotificationRequest {
  headers: Record<string, string>;
  body: string;
}

const TEST_TITLE = 'Test notification from Volverán';
const TEST_NOTE = 'This is a test of this Alert Destination: nothing is wrong and no Alert is firing.';
const LINK_TEXT = 'Open in Volverán';
/** Slack refuses a longer header block, and with it the whole notification. */
const SLACK_HEADER_LIMIT = 150;

/** A clearly labelled test notification; `alertId` is new each time, so nothing takes it for a repeat. */
export function testNotification(at: Date, alertId: string): Notification {
  return {
    alertId,
    status: 'firing',
    rule: 'Test notification',
    profile: null,
    vhost: null,
    queue: null,
    condition: 'test',
    value: null,
    threshold: null,
    startedAt: at.toISOString(),
    endedAt: null,
    path: '/',
    test: true,
  };
}

/** The HTTP request for one attempt: a webhook's timestamp and signature are of the time `at`. */
export function buildRequest(
  destination: PayloadTarget,
  notification: Notification,
  publicUrl: string | null,
  at: Date,
): NotificationRequest {
  const url = publicUrl !== null && notification.path !== null ? publicUrl + notification.path : null;
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (destination.type === 'slack') return { headers, body: JSON.stringify(slackPayload(notification, url)) };
  if (destination.type === 'teams') return { headers, body: JSON.stringify(teamsPayload(notification, url)) };
  const body = JSON.stringify(webhookPayload(notification, url));
  if (destination.signingSecret !== null) {
    const timestamp = String(Math.floor(at.getTime() / 1000));
    headers['x-volveran-timestamp'] = timestamp;
    headers['x-volveran-signature'] = signWebhook(destination.signingSecret, timestamp, body);
  }
  return { headers, body };
}

/** The `x-volveran-signature` header: the hex HMAC-SHA256 of `<timestamp>.<body>`. */
export function signWebhook(secret: string, timestamp: string, body: string): string {
  return `sha256=${createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex')}`;
}

/** Version 1 of the generic webhook's documented JSON body. */
function webhookPayload(n: Notification, url: string | null) {
  return {
    version: 1,
    test: n.test === true,
    alertId: n.alertId,
    status: n.status,
    rule: n.rule,
    profile: n.profile,
    vhost: n.vhost,
    queue: n.queue,
    condition: n.condition,
    value: n.value,
    threshold: n.threshold,
    replayRule: n.replayRule ?? null,
    reason: n.reason ?? null,
    startedAt: n.startedAt,
    endedAt: n.endedAt,
    url,
  };
}

function titleOf(n: Notification): string {
  if (n.test) return TEST_TITLE;
  return `${n.status === 'firing' ? 'Firing' : 'Resolved'}: ${n.rule}`;
}

/** The facts a person reads, leaving out what does not apply. */
function factsOf(n: Notification): Array<{ title: string; value: string }> {
  const facts: Array<[string, unknown]> = [
    ['Profile', n.profile],
    ['Vhost', n.vhost],
    ['Queue', n.queue],
    ['Condition', n.test ? null : n.condition],
    ['Replay rule', n.replayRule ?? null],
    ['Reason', n.reason ?? null],
    ['Value', n.value],
    ['Threshold', n.threshold],
    ['Since', n.test ? null : n.startedAt],
    ['Ended', n.endedAt],
  ];
  return facts.filter(([, value]) => value !== null).map(([title, value]) => ({ title, value: String(value) }));
}

function slackEscape(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function slackPayload(n: Notification, url: string | null) {
  const title = titleOf(n);
  const facts = factsOf(n);
  const fallback = [title, ...facts.map((f) => `${f.title}: ${f.value}`)].join(', ');
  const section = (text: string) => ({ type: 'section', text: { type: 'mrkdwn', text } });
  return {
    text: slackEscape(n.test ? `${title}. ${TEST_NOTE}` : fallback),
    blocks: [
      { type: 'header', text: { type: 'plain_text', text: title.slice(0, SLACK_HEADER_LIMIT) } },
      ...(n.test ? [section(TEST_NOTE)] : []),
      ...(facts.length > 0
        ? [{ type: 'section', fields: facts.map((f) => ({ type: 'mrkdwn', text: `*${f.title}*\n${slackEscape(f.value)}` })) }]
        : []),
      ...(url !== null ? [section(`<${url}|${LINK_TEXT}>`)] : []),
    ],
  };
}

/** A message for a Teams workflow (Power Automate) webhook; Office 365 connector URLs are not targeted. */
function teamsPayload(n: Notification, url: string | null) {
  const facts = factsOf(n);
  return {
    type: 'message',
    attachments: [
      {
        contentType: 'application/vnd.microsoft.card.adaptive',
        contentUrl: null,
        content: {
          $schema: 'http://adaptivecards.io/schemas/adaptive-card.json',
          type: 'AdaptiveCard',
          version: '1.4',
          body: [
            { type: 'TextBlock', text: titleOf(n), weight: 'Bolder', size: 'Medium', wrap: true },
            ...(n.test ? [{ type: 'TextBlock', text: TEST_NOTE, wrap: true }] : []),
            ...(facts.length > 0 ? [{ type: 'FactSet', facts }] : []),
          ],
          actions: url !== null ? [{ type: 'Action.OpenUrl', title: LINK_TEXT, url }] : [],
        },
      },
    ],
  };
}
