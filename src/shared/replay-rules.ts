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
  /** Matching Messages whose attempts are used up. */
  usedUp: number;
  /** Matching Messages still waiting for their back-off, and those past the pass's `maxPerPass`. */
  notDue: number;
  /** Messages the rule's filter does not select. */
  noMatch: number;
  /** Replays that failed or were not attempted; their Messages went back to the queue. */
  failed: number;
}

/** A Rule Pass that ran: its id (recorded on its Audit Entries), when, and its counts. */
export interface RulePass {
  id: string;
  /** ISO time it started. */
  at: string;
  summary: RulePassSummary;
}

/** A rule as GET /api/profiles/:profile/replay-rules lists it. */
export interface ReplayRuleView {
  rule: ReplayRule;
  /** The last pass run on demand since Volverán started; null when none ran. */
  lastPass: RulePass | null;
}

/** The Operator name a rule acts as, in Audit Entries, the queue list and "held by". */
export function ruleDisplayName(name: string): string {
  return `Replay rule ${name}`;
}
