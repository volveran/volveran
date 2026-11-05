// What the screenshot run does to the broker before it records the read-only
// views (scripts/screenshots/capture.sh), done to the demo's broker so that
// the demo starts where the recording does:
//
// - shot.mjs `prep`: on staging, a Checkout of orders.dlq; Discard its head
//   ("Duplicate of order 880210, already fulfilled"), Replay the next two,
//   Apply. Three Audit Entries, the History mark's Apply.
// - die-again.mjs: every Message waiting in orders.work is rejected, so both
//   Replays are dead-lettered again (orders.dlx fans them out to orders.dlq
//   and its two quorum siblings) and are Died Again in the next Checkout.
//
// The Apply's time, Operator and Checkout id are the recorded mark's, so its
// audit link finds these entries. The two Replayed Messages did not time out
// on the database, so a later Replay of them succeeds; the
// SQLTimeoutException ones are untouched and still die again.
import type { AuditLog } from './audit-log.js';
import type { DemoBroker } from './broker.js';
import { republished, stepEntry, type ApplyTarget, type AuditDetails } from './apply.js';
import { replayOrigin } from './message-view.js';

/** The prep's Apply, as the recorded History mark shows it. */
export interface PrepApply {
  checkoutId: string;
  /** When it ran. */
  at: Date;
  operator: string;
  /** staging's broker user, as its Audit Entries record it. */
  brokerUser: string;
}

export const PREP_DISCARD_REASON = 'Duplicate of order 880210, already fulfilled';

const ORDERS_DLQ = { vhost: '/', queue: 'orders.dlq' };

export function applyScreenshotPrep(broker: DemoBroker, audit: AuditLog, apply: PrepApply): void {
  const target: ApplyTarget = {
    profile: 'staging',
    ...ORDERS_DLQ,
    checkoutId: apply.checkoutId,
    operator: apply.operator,
    role: 'admin',
    brokerUser: apply.brokerUser,
  };
  const options = { at: apply.at, rate: null, canary: false };
  const [head, ...replayed] = broker.hold(ORDERS_DLQ, 3);
  if (!head || replayed.length !== 2) throw new Error('The scenario has fewer than 3 Messages in orders.dlq.');

  const discard: AuditDetails = { action: 'discard', reason: PREP_DISCARD_REASON, destination: null, copy: 'full', replayId: null };
  const discardId = audit.record(stepEntry(target, head, discard, options));
  broker.ack(ORDERS_DLQ, head);
  audit.setOutcome(discardId, 'done');

  for (const message of replayed) {
    const origin = replayOrigin(message.properties.headers);
    if (!origin.ok) throw new Error(`The prep cannot Replay ${message.properties.messageId}: ${origin.reason}`);
    const details: AuditDetails = {
      action: 'replay',
      reason: null,
      destination: { exchange: '', routingKey: origin.queue, queue: origin.queue },
      copy: 'headers',
      replayId: crypto.randomUUID(),
    };
    const id = audit.record(stepEntry(target, message, details, options));
    // Published to the work queue, where die-again.mjs rejects it: dead-lettered again.
    const work = { vhost: ORDERS_DLQ.vhost, queue: origin.queue };
    const copy = { exchange: '', routingKey: origin.queue, redelivered: false, properties: republished(message.properties, details.replayId!, ORDERS_DLQ.queue), content: message.content };
    broker.ack(ORDERS_DLQ, message);
    audit.setOutcome(id, 'done');
    broker.reject(work, copy, apply.at);
  }
}
