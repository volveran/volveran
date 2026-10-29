// Pure (no I/O): what a Replay Rule makes of one Message. A Rule Pass asks
// this for each Message it holds; the Message row's rule badge asks it too.
//
// - no_match: the rule's filter does not select it.
// - used_up: its attempts reached `maxAttempts`.
// - not_due: its back-off delay has not passed yet.
// - replay: otherwise.
//
// Attempts are the Message's Died Again count, so they survive a restart and
// count Replays by people and other rules too (ADR 0011). The delay before
// attempt n is `min(initial × multiplier^n, max)`, measured from the most
// recent `x-death` time, else the Failure Details' fault time, else the time
// the rule first saw the Message (when the caller knows it). A Message with
// none of these is due now.
import { matchesFilter } from '../triage/filters.js';
import { failureDetails } from '../triage/failure-details.js';
import { parseXDeath, type Delivery } from '../triage/message-view.js';
import type { ReplayRule, RuleVerdict } from '../../shared/replay-rules.js';

export type { RuleVerdict };

/** The facts about one Message a rule decides on. */
export interface RuleMessage {
  delivery: Delivery;
  /** How many times it has died again (triage/died-again.ts); 0 when it is not Died Again. */
  diedAgainCount: number;
  /** When a pass of this rule first saw it, the last fallback for when it was dead-lettered. */
  firstSeenAt?: Date | null;
}

export interface RuleEvaluation {
  verdict: RuleVerdict;
  /** The attempts used so far. */
  attempts: number;
  /** When its back-off delay passes; null when the rule does not select it or its attempts are used up. */
  nextAttemptAt: Date | null;
}

export function evaluateRule(rule: ReplayRule, message: RuleMessage, now: Date): RuleEvaluation {
  const attempts = message.diedAgainCount;
  if (rule.filter && !matchesFilter(rule.filter, message.delivery)) return { verdict: 'no_match', attempts, nextAttemptAt: null };
  if (attempts >= rule.maxAttempts) return { verdict: 'used_up', attempts, nextAttemptAt: null };
  const since = deadLetteredAt(message.delivery.properties.headers) ?? message.firstSeenAt ?? null;
  if (since === null) return { verdict: 'replay', attempts, nextAttemptAt: now };
  const nextAttemptAt = new Date(since.getTime() + backoffDelayMs(rule.backoff, attempts));
  return { verdict: nextAttemptAt.getTime() <= now.getTime() ? 'replay' : 'not_due', attempts, nextAttemptAt };
}

/** The delay before attempt `attempts` (0 for the first): `initial × multiplier^attempts`, at most `max`. */
export function backoffDelayMs(backoff: ReplayRule['backoff'], attempts: number): number {
  return Math.min(backoff.initialMs * backoff.multiplier ** attempts, backoff.maxMs);
}

/** When the Message was last dead-lettered: its most recent `x-death` time, else its Failure Details' fault time. */
function deadLetteredAt(headers: Record<string, unknown> | undefined): Date | null {
  const times = parseXDeath(headers)
    .map((e) => (e.time === null ? NaN : Date.parse(e.time)))
    .filter((t) => !Number.isNaN(t));
  if (times.length > 0) return new Date(Math.max(...times));
  const faultAt = failureDetails(headers)?.faultAt;
  const fault = faultAt ? Date.parse(faultAt) : NaN;
  return Number.isNaN(fault) ? null : new Date(fault);
}
