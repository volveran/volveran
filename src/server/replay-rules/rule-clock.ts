// The clock the Replay Rule scheduler runs on (rules.ts), and its test seams.
// In production it is the wall clock and Node's timers; tests replace it with
// a clock that moves only when told, and take "run a pass now" to run a
// rule's scheduled pass at once (an extension of the Checkout test hooks).
import type { RulePass } from '../../shared/replay-rules.js';

export interface RuleClock {
  now(): Date;
  /** Calls `run` once, `ms` from now, unless cancelled. */
  setTimer(run: () => void, ms: number): { cancel(): void };
}

export const systemClock: RuleClock = {
  now: () => new Date(),
  setTimer(run, ms) {
    const timer = setTimeout(run, ms);
    // A scheduled pass never keeps the process alive on its own.
    timer.unref();
    return { cancel: () => clearTimeout(timer) };
  },
};

/** What a test can do to the scheduler. */
export interface RuleSchedulerControl {
  /**
   * Runs the scheduled pass of rule `rule` of profile `profile` at once, as
   * its timer would (and schedules the next one); resolves with the pass, or
   * null when the scheduler would not run it (paused, or a pass of it is
   * already running).
   */
  runScheduledPass(profile: string, rule: string): Promise<RulePass | null>;
}

export interface RuleSchedulerTestHooks {
  /** Replaces the wall clock and timers. */
  clock?: RuleClock;
  /** Receives the scheduler's control once it has started. */
  scheduler?(control: RuleSchedulerControl): void;
}

