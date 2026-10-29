// The Replay Rules of every Broker Profile (ADR 0011), owned by the server
// like the Checkout manager: their declarations from the profiles file, their
// state in the audit store (audit/rule-state.ts), and the scheduler.
//
// - start() gives every rule its state the first time it is seen (paused
//   when `startPaused`; the stored state wins afterwards) and schedules each
//   running rule. Rules removed from the file are not asked about; their
//   state and Audit Entries stay.
// - A running rule passes every `every`, plus a small random jitter, counted
//   from its last pass (so a restart does not delay it). A paused rule has no
//   next pass. Only one pass of a rule runs at a time.
// - A pass whose queue is held is skipped and recorded as skipped; one whose
//   Checkout cannot start for another reason is recorded as failed. Every
//   pass, scheduled or Run now, goes into the rule's history.
// - stop() cancels the timers and waits for the passes in progress.
//
// #65 (automatic stop, pause and resume) hooks in at `afterPass` and pauses
// through `RuleStateStore.setPaused`, then `reschedule`.
import { randomUUID } from 'node:crypto';
import { HttpError } from '../http-error.js';
import type { RuleStateStore } from '../audit/rule-state.js';
import type { CheckoutManager } from '../checkout/manager.js';
import type { BrokerProfile } from '../profiles.js';
import type { Delivery } from '../triage/message-view.js';
import type { ReplayRule, ReplayRuleView, RuleBadge, RulePass } from '../../shared/replay-rules.js';
import { evaluateRule } from './evaluate.js';
import { runRulePass } from './pass.js';
import { jitterMs, systemClock, type RuleClock, type RuleSchedulerTestHooks } from './scheduler.js';

export interface ReplayRulesOptions {
  checkouts: CheckoutManager;
  state: RuleStateStore;
  profiles: readonly BrokerProfile[];
  testHooks?: RuleSchedulerTestHooks;
  /** A scheduled pass broke unexpectedly (not a skip or a refused Checkout, which are recorded). */
  onError?(ruleKey: string, err: unknown): void;
}

export class ReplayRules {
  private readonly clock: RuleClock;
  /** Rule key → its next pass's timer and time, while it is scheduled. */
  private readonly timers = new Map<string, { at: Date; cancel(): void }>();
  /** Rule key → its pass in progress. */
  private readonly running = new Map<string, Promise<RulePass>>();
  private stopped = false;

  constructor(private readonly options: ReplayRulesOptions) {
    this.clock = options.testHooks?.clock ?? systemClock;
  }

  /** Gives every declared rule its state and schedules the running ones. */
  start(): void {
    for (const profile of this.options.profiles) {
      for (const rule of profile.replayRules) {
        this.options.state.ensure(ruleKey(profile, rule.name), rule.startPaused);
        this.reschedule(profile, rule);
      }
    }
    this.options.testHooks?.scheduler?.({
      runScheduledPass: (profileName, name) => {
        const profile = this.options.profiles.find((p) => p.name === profileName);
        if (!profile) throw new Error(`No Broker Profile "${profileName}"`);
        return this.runScheduled(profile, this.find(profile, name));
      },
    });
  }

  /** Cancels every timer and waits for the passes in progress to end. */
  async stop(): Promise<void> {
    this.stopped = true;
    for (const timer of this.timers.values()) timer.cancel();
    this.timers.clear();
    await Promise.allSettled([...this.running.values()]);
  }

  /** The rules of `profile`, in file order, with their state, last passes and next pass time. */
  list(profile: BrokerProfile): ReplayRuleView[] {
    return profile.replayRules.map((rule) => {
      const key = ruleKey(profile, rule.name);
      return {
        rule,
        state: this.options.state.ensure(key, rule.startPaused),
        passes: this.options.state.passes(key),
        nextPassAt: this.timers.get(key)?.at.toISOString() ?? null,
      };
    });
  }

  /** The rule named `name` of `profile`; throws 404 `replay_rule_not_found`. */
  find(profile: BrokerProfile, name: string): ReplayRule {
    const rule = profile.replayRules.find((r) => r.name === name);
    if (!rule) throw new HttpError(404, 'replay_rule_not_found', `Broker Profile "${profile.name}" has no Replay rule named "${name}".`);
    return rule;
  }

  /**
   * Runs one pass of the rule now, even when it is paused, and records it.
   * Throws `replay_rule_not_found`, and what the pass's Checkout start throws
   * (409 `checkout_in_progress` with the holder while the queue is held; the
   * pass is recorded as skipped).
   */
  async runNow(profile: BrokerProfile, name: string): Promise<RulePass> {
    const rule = this.find(profile, name);
    const { pass, error } = await this.pass(profile, rule);
    if (error !== undefined) throw error;
    return pass;
  }

  /**
   * The rule badge of one Message in a Checkout of `vhost`/`queue`: the first
   * running rule of the profile on that queue that matches it; null when none.
   */
  badge(profile: BrokerProfile, vhost: string, queue: string, delivery: Delivery, diedAgainCount: number): RuleBadge | null {
    for (const rule of profile.replayRules) {
      if (rule.vhost !== vhost || rule.queue !== queue) continue;
      const key = ruleKey(profile, rule.name);
      if (this.options.state.state(key)?.paused ?? rule.startPaused) continue;
      const messageId = typeof delivery.properties.messageId === 'string' ? delivery.properties.messageId : null;
      const firstSeenAt = messageId === null ? null : this.options.state.firstSeenAt(key, messageId);
      const evaluation = evaluateRule(rule, { delivery, diedAgainCount, firstSeenAt }, this.clock.now());
      if (evaluation.verdict === 'no_match') continue;
      return {
        name: rule.name,
        attempts: evaluation.attempts,
        maxAttempts: rule.maxAttempts,
        usedUp: evaluation.verdict === 'used_up',
        nextAttemptAt: evaluation.nextAttemptAt?.toISOString() ?? null,
      };
    }
    return null;
  }

  /** Schedules the rule's next pass from its last one, or clears it while the rule is paused. */
  reschedule(profile: BrokerProfile, rule: ReplayRule): void {
    const key = ruleKey(profile, rule.name);
    this.timers.get(key)?.cancel();
    this.timers.delete(key);
    if (this.stopped || this.options.state.state(key)?.paused !== false) return;
    const now = this.clock.now().getTime();
    const last = this.options.state.passes(key)[0];
    const base = last ? Math.max(now, Date.parse(last.at) + rule.everyMs) : now + rule.everyMs;
    const at = base + jitterMs(rule.everyMs);
    const timer = this.clock.setTimer(() => {
      this.timers.delete(key);
      this.runScheduled(profile, rule).catch((err) => this.options.onError?.(key, err));
    }, at - now);
    this.timers.set(key, { at: new Date(at), cancel: timer.cancel });
  }

  /** The scheduled pass: not run while the rule is paused or a pass of it is running. */
  private async runScheduled(profile: BrokerProfile, rule: ReplayRule): Promise<RulePass | null> {
    const key = ruleKey(profile, rule.name);
    if (this.stopped || this.running.has(key) || this.options.state.state(key)?.paused !== false) return null;
    return (await this.pass(profile, rule)).pass;
  }

  /** Runs and records one pass; a skip or a refused start is recorded and returned with its error. */
  private async pass(profile: BrokerProfile, rule: ReplayRule): Promise<{ pass: RulePass; error?: unknown }> {
    const key = ruleKey(profile, rule.name);
    let error: unknown;
    const now = this.clock.now();
    const running = runRulePass(this.options.checkouts, profile, rule, {
      now,
      firstSeen: (ids, at) => this.options.state.firstSeen(key, ids, at),
    }).catch((err): RulePass => {
      error = err;
      const skipped = err instanceof HttpError && (err.code === 'checkout_in_progress' || err.code === 'operator_has_checkout');
      return {
        id: randomUUID(),
        at: now.toISOString(),
        status: skipped ? 'skipped' : 'failed',
        summary: null,
        reason: (err as Error).message,
      };
    });
    const recorded = running.then((pass) => {
      this.options.state.recordPass(key, pass);
      this.afterPass(profile, rule, pass);
      return pass;
    });
    this.running.set(key, recorded);
    try {
      return { pass: await recorded, error };
    } finally {
      this.running.delete(key);
      this.reschedule(profile, rule);
    }
  }

  /** Called after each recorded pass; #65's automatic stop goes here. */
  private afterPass(_profile: BrokerProfile, _rule: ReplayRule, _pass: RulePass): void {}
}

function ruleKey(profile: BrokerProfile, rule: string): string {
  return `${profile.name}/${rule}`;
}
