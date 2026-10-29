// A Rule Pass (ADR 0011): one run of a Replay Rule.
//
// 1. It takes an ordinary Checkout of the rule's queue, through the same
//    path, in-process lock and lock queue as an Operator's, as the Operator
//    `{ id: 'rule:<profile>/<name>', displayName: 'Replay rule <name>' }`,
//    connecting with the profile's own broker user. The Checkout holds at
//    most `maxPerPass` × KEPT_FACTOR Messages (the head of the queue), so a
//    pass that Keeps some still finds Messages to Replay. When the queue is
//    held, the start throws 409 `checkout_in_progress` naming the holder, and
//    nothing is touched.
// 2. It decides for each held Message with evaluate.ts, from its headers, its
//    Died Again count and when a pass of the rule first saw it (the caller's
//    rule state, by message id).
// 3. It gives Replay to the first `maxPerPass` Messages that are due, and
//    Move to the rule's parking queue to those whose attempts are used up
//    when the rule says `whenAttemptsUsedUp: { moveTo }` (an ordinary Move,
//    its Audit Entry naming the rule). It Applies at the rule's Replay Rate,
//    with no Approval or confirmation; the Apply ends the Checkout, which
//    Keeps every other Message in order (no Delivery Budget used on a quorum
//    queue). With nothing to do it just ends the Checkout.
//
// The result is the pass's counts, and what the automatic stop looks at: the
// Audit Entries its Died Again Messages last came from, and how its publishes
// failed. The caller keeps the counts and decides on the stop (rules.ts).
import { randomUUID } from 'node:crypto';
import { brokerCredentials } from '../broker-credentials.js';
import type { CheckoutManager } from '../checkout/manager.js';
import { stageDecisions } from '../checkout/staging.js';
import { ManagementClient } from '../management.js';
import type { Operator } from '../operator.js';
import type { QueueAccess } from '../profile-access.js';
import type { BrokerProfile } from '../profiles.js';
import { ruleDisplayName, type ReplayRule, type RulePass, type RulePassSummary } from '../../shared/replay-rules.js';
import { evaluateRule } from './evaluate.js';

/** How many Messages a pass holds per Message it may Replay, so that the Kept ones do not crowd out the due ones. */
export const KEPT_FACTOR = 3;

/** The Operator a rule acts as: recorded in its Audit Entries, and named as the holder of the queue during a pass. */
export function ruleOperator(profile: string, rule: string): Operator {
  return { id: `rule:${profile}/${rule}`, displayName: ruleDisplayName(rule) };
}

export interface RulePassOptions {
  /** The time the back-off is measured against (default: when the pass starts). */
  now?: Date;
  /** When a pass of the rule first saw each message id (rule state), storing `now` for new ones; default none. */
  firstSeen?(messageIds: string[], now: Date): Map<string, Date>;
}

/** What a pass saw that its automatic stop needs (not kept with the pass). */
export interface RulePassFindings {
  /** The Audit Entry each held Died Again Message last came from (any Operator's; the caller picks the rule's). */
  diedAgainEntryIds: number[];
  /** How its Replays and Moves failed: none, the broker refused a publish its permissions, or a publish failed otherwise. */
  publishFailure: null | 'refused' | 'failed';
}

/** Runs one pass of `rule` of `profile`; throws when its Checkout cannot start (the queue is held, missing, refused). */
export async function runRulePass(
  checkouts: CheckoutManager,
  profile: BrokerProfile,
  rule: ReplayRule,
  options: RulePassOptions = {},
): Promise<{ pass: RulePass & { summary: RulePassSummary }; findings: RulePassFindings }> {
  const now = options.now ?? new Date();
  const pass = { id: randomUUID(), at: now.toISOString() };
  const operator = ruleOperator(profile.name, rule.name);
  const credentials = () => brokerCredentials(profile, operator);
  const target: QueueAccess = {
    profile,
    vhost: rule.vhost,
    queue: rule.queue,
    role: 'operator',
    management: new ManagementClient(profile, credentials),
    credentials,
  };
  const started = await checkouts.start(target, operator, { maxMessages: rule.maxPerPass * KEPT_FACTOR });
  const checkout = checkouts.checkout(started.id);
  const summary: RulePassSummary = { held: checkout.held.size, replayed: 0, moved: 0, usedUp: 0, notDue: 0, noMatch: 0, cannotReplay: 0, failed: 0 };
  const findings: RulePassFindings = {
    diedAgainEntryIds: [...checkout.diedAgain.values()].flatMap((d) => (d.last ? [d.last.auditEntryId] : [])),
    publishFailure: null,
  };
  try {
    const messageIds = [...checkout.held.values()].flatMap((d) => (typeof d.properties.messageId === 'string' ? [d.properties.messageId] : []));
    const firstSeen = options.firstSeen?.(messageIds, now) ?? new Map<string, Date>();
    const due: number[] = [];
    const usedUp: number[] = [];
    for (const [handle, delivery] of checkout.held) {
      const messageId = typeof delivery.properties.messageId === 'string' ? delivery.properties.messageId : null;
      const { verdict } = evaluateRule(
        rule,
        {
          delivery,
          diedAgainCount: checkout.diedAgain.get(handle)?.count ?? 0,
          firstSeenAt: messageId === null ? null : (firstSeen.get(messageId) ?? null),
        },
        now,
      );
      if (verdict === 'used_up') usedUp.push(handle);
      else if (verdict === 'no_match') summary.noMatch++;
      else if (verdict === 'not_due' || due.length >= rule.maxPerPass) summary.notDue++;
      else due.push(handle);
    }
    summary.usedUp = usedUp.length;
    // A Message with nowhere to Replay to (no origin, e.g. Spring AMQP) is Kept and counted apart: nothing failed on the broker.
    summary.cannotReplay = due.length === 0 ? 0 : stageDecisions(checkout, due, { kind: 'replay' }).length;
    const parking = rule.whenAttemptsUsedUp === 'keep' ? null : rule.whenAttemptsUsedUp.moveTo.queue;
    if (parking !== null && usedUp.length > 0) {
      summary.failed += stageDecisions(checkout, usedUp, { kind: 'move', destination: { queue: parking } }).length;
    }
    if (checkout.decisions.size === 0) {
      await checkouts.end(checkout.id, 'applied');
    } else {
      const ended = await checkouts.applyForRule(checkout.id, { rate: rule.rate, rule: { name: rule.name, passId: pass.id } });
      for (const o of ended.lastApply?.outcomes ?? []) {
        if (o.decision.kind !== 'replay' && o.decision.kind !== 'move') continue;
        if (o.status === 'failed') findings.publishFailure = o.refused || findings.publishFailure === 'refused' ? 'refused' : 'failed';
        if (o.status !== 'done') summary.failed++;
        else if (o.decision.kind === 'replay') summary.replayed++;
        else summary.moved++;
      }
    }
  } finally {
    // Whatever went wrong, the held Messages go back to the queue.
    if (checkouts.isRunning(checkout.id)) await checkouts.end(checkout.id, 'applied').catch(() => {});
  }
  return { pass: { ...pass, status: 'ran', summary, reason: null }, findings };
}
