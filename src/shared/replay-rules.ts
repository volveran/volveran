// Replay Rules as the profiles file declares them and the API lists them,
// shared by the server and the web app. Pure values and types (no Node or
// DOM APIs). The server parses them in src/server/replay-rules/config.ts.
import type { Filter } from './filters.js';

/** How long a rule waits between attempts for one Message: `initial × multiplier^attempts`, at most `max`. */
export interface Backoff {
  initialMs: number;
  /** At least 1. */
  multiplier: number;
  maxMs: number;
}

/** What a pass does with a Message whose attempts are used up: leave it, or Move it to a parking queue. */
export type WhenAttemptsUsedUp = 'keep' | { moveTo: { queue: string } };

/** A Replay Rule: which Messages of one dead-letter queue Volverán Replays automatically, how often and how many times. */
export interface ReplayRule {
  /** Unique within its Broker Profile: letters, digits, `-` and `_`. */
  name: string;
  vhost: string;
  queue: string;
  /** The Messages it Replays; null matches every Message. */
  filter: Filter | null;
  /** How often a pass runs. */
  everyMs: number;
  /** The most Messages one pass Replays. */
  maxPerPass: number;
  /** Its Replay Rate, in Messages per second. */
  rate: number;
  backoff: Backoff;
  /** The most attempts per Message, counted from its Died Again count. */
  maxAttempts: number;
  whenAttemptsUsedUp: WhenAttemptsUsedUp;
  /** The automatic stop: pause once `diedAgain` of its Replayed Messages die again within `withinMs`. */
  stopWhen: { diedAgain: number; withinMs: number };
  /** Starts paused until an `admin` resumes it. */
  startPaused: boolean;
}

/** What a pass made of each Message it held (src/server/replay-rules/evaluate.ts). */
export type RuleVerdict = 'replay' | 'used_up' | 'not_due' | 'no_match';

/** The counts of one Rule Pass. */
export interface RulePassSummary {
  /** Messages the pass held in its Checkout. */
  held: number;
  /** Replays the broker confirmed. */
  replayed: number;
  /** Matching Messages whose attempts are used up (Kept, or Moved to the parking queue). */
  usedUp: number;
  /** Of those, the ones Moved to the rule's parking queue (`whenAttemptsUsedUp.moveTo`). */
  moved: number;
  /** Matching Messages still waiting for their back-off, those past the pass's `maxPerPass`, and those a pause left unattempted. */
  notDue: number;
  /** Messages the rule's filter does not select. */
  noMatch: number;
  /** Due Messages it cannot Replay because they have nowhere to go (no Replay origin, e.g. Spring AMQP); Kept, and no reason to pause. */
  cannotReplay: number;
  /** Replays and Moves that failed or were not attempted; their Messages went back to the queue. */
  failed: number;
}

/**
 * How a Rule Pass went. ran: it held the queue and acted. skipped: someone
 * held the queue, so it touched nothing. failed: its Checkout could not start
 * (the queue is missing, the broker refused) or it broke off; `reason` says why.
 */
export type RulePassStatus = 'ran' | 'skipped' | 'failed';

/** A Rule Pass: its id (recorded on its Audit Entries), when, how it went, and its counts. */
export interface RulePass {
  id: string;
  /** ISO time it started. */
  at: string;
  status: RulePassStatus;
  /** The counts of a pass that ran; null when it was skipped or failed. */
  summary: RulePassSummary | null;
  /** Why it was skipped or failed, or what stopped it part way; null when it ran to its end. */
  reason: string | null;
}

/** Why a rule paused itself (its automatic stop), as stored in `RuleState.pausedReason`. */
export const AUTOMATIC_PAUSE_REASONS = {
  died_again: 'too many of the Messages it Replayed died again within its window',
  queue_not_found: 'its queue does not exist',
  broker_permission_denied: 'the broker refused its broker user a permission it needs',
  lock_not_permitted: 'its broker user may not declare the Checkout lock queue',
  publish_failed: 'a Replay or Move of its last pass failed to publish',
} as const;

/** How much of a pause's reason leaves Volverán: an Operator's can be any length, and chat tools refuse a long field, and the whole notification with it. */
export const PAUSE_REASON_LIMIT = 500;

/** A pause reason as people read it: the automatic stop's reasons in words, an Operator's as written. */
export function pauseReasonText(reason: string): string {
  return (AUTOMATIC_PAUSE_REASONS as Record<string, string>)[reason] ?? reason;
}

/** A rule's state, kept in the audit store across restarts. */
export interface RuleState {
  /** A paused rule runs no scheduled passes (Run now still runs one). */
  paused: boolean;
  /** Why, who (an Operator's name, or the rule itself) and when it paused; null while it runs. */
  pausedReason: string | null;
  pausedBy: string | null;
  /** ISO time. */
  pausedAt: string | null;
}

/** A rule as GET /api/profiles/:profile/replay-rules lists it. */
export interface ReplayRuleView {
  rule: ReplayRule;
  state: RuleState;
  /** Its last passes, newest first (a bounded history). */
  passes: RulePass[];
  /** ISO time of its next scheduled pass; null while it is paused. */
  nextPassAt: string | null;
}

/** A running rule's view of one Message it matches, on the Message's row and in the Message view. */
export interface RuleBadge {
  /** The rule's name. */
  name: string;
  /** Attempts used so far (the Message's Died Again count). */
  attempts: number;
  maxAttempts: number;
  /** The rule has given up on it: a person needs to look at it. */
  usedUp: boolean;
  /** ISO time its back-off delay passes; null when its attempts are used up. */
  nextAttemptAt: string | null;
}

/** A duration as the profiles file writes it, from the largest unit down, e.g. "1h30m". */
export function durationText(ms: number): string {
  const units: Array<[string, number]> = [
    ['d', 86_400_000],
    ['h', 3_600_000],
    ['m', 60_000],
    ['s', 1000],
  ];
  let left = Math.round(ms / 1000) * 1000;
  let text = '';
  for (const [unit, size] of units) {
    if (left >= size) {
      text += `${Math.floor(left / size)}${unit}`;
      left %= size;
    }
  }
  return text || '0s';
}

/** The Operator name a rule acts as, in Audit Entries, the queue list and "held by". */
export function ruleDisplayName(name: string): string {
  return `Replay rule ${name}`;
}
