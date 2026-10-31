// The Replay Rules of every Broker Profile (ADR 0011), owned by the server
// like the Checkout manager: their declarations from the profiles file, their
// state in the audit store (audit/audit-store.ts), and the scheduler.
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
// - The automatic stop, after every pass (Run now too): the rule pauses with
//   reason `died_again` once the Died Again Messages its passes saw within
//   `stopWhen.within`, whose last Audit Entry is this rule's, reach
//   `stopWhen.diedAgain`; with `queue_not_found`, `broker_permission_denied`
//   or `lock_not_permitted` when its Checkout could not start for that; and
//   with `broker_permission_denied` or `publish_failed` when a Replay or Move
//   of the pass failed to publish. A rule already paused stays as it is.
// - pause() (an Operator, with a reason) and resume() (which clears the
//   automatic stop's count). Every pause and resume, automatic or not, is an
//   Audit Entry with no Message: `rule_pause` / `rule_resume`, the Operator
//   being the person or the rule itself, and the reason.
// - A store call is an interleave point (ADR 0013), so what reads a rule's state
//   and then acts on it (pause, resume, the automatic stop, scheduling) takes the
//   rule's turn.
import { randomUUID } from 'node:crypto';
import { sharedBrokerUser } from '../broker-credentials.js';
import { HttpError, InvalidRequestError } from '../http-error.js';
import type { AuditStore, RuleStateStore } from '../audit/audit-store.js';
import type { CheckoutManager } from '../checkout/manager.js';
import { OneAtATime } from '../one-at-a-time.js';
import type { Operator } from '../operator.js';
import type { BrokerProfile } from '../profiles.js';
import { messageIdOf, type Delivery } from '../triage/message-view.js';
import type { ReplayRule, ReplayRuleView, RuleBadge, RulePass, RuleState } from '../../shared/replay-rules.js';
import type { Role } from '../../shared/roles.js';
import { replayRuleNotFound, replayRulePaused, replayRuleRunning } from './errors.js';
import { evaluateRule } from './evaluate.js';
import { ruleKey, ruleOperator, runRulePass, type RulePassFindings } from './pass.js';
import { systemClock, type RuleClock, type RuleSchedulerTestHooks } from './rule-clock.js';

/** The Checkout start errors that pause a rule, each its own reason: they will not go away by themselves. */
const PAUSING_START_ERRORS = new Set(['queue_not_found', 'broker_permission_denied', 'lock_not_permitted']);

/** The longest random jitter added to a pass's interval, so rules declared alike do not all pass at once. */
export const MAX_JITTER_MS = 30_000;

/** A random jitter for a rule passing every `everyMs`: up to a tenth of it, at most MAX_JITTER_MS. */
export function jitterMs(everyMs: number, random: () => number = Math.random): number {
  return Math.floor(random() * Math.min(everyMs / 10, MAX_JITTER_MS));
}

/** Who pauses or resumes a rule (the rule itself for an automatic stop), recorded in the Audit Entry. */
interface RuleActor {
  operator: Operator;
  role: Role;
}

export interface ReplayRulesOptions {
  checkouts: CheckoutManager;
  state: RuleStateStore;
  /** Where the pauses and resumes are recorded as Audit Entries. */
  audit: Pick<AuditStore, 'record' | 'setOutcome'>;
  profiles: readonly BrokerProfile[];
  testHooks?: RuleSchedulerTestHooks;
  /** A scheduled pass broke unexpectedly (not a skip or a refused Checkout, which are recorded). */
  onError?(ruleKey: string, err: unknown): void;
  /** A pass was recorded, scheduled or Run now. */
  onPassRecorded?(profile: string, rule: string, pass: RulePass): void;
  /** A rule was paused or resumed, automatically or by an Operator. Must not reject. */
  onPauseChanged?(profile: string): Promise<void>;
}

export class ReplayRules {
  private readonly clock: RuleClock;
  /** Rule key → its next pass's timer and time, while it is scheduled. */
  private readonly timers = new Map<string, { at: Date; cancel(): void }>();
  /** Rule key → its passes in progress: at most one scheduled, and any Run now beside it. */
  private readonly running = new Map<string, Set<Promise<unknown>>>();
  private readonly turns = new OneAtATime();
  private stopped = false;

  constructor(private readonly options: ReplayRulesOptions) {
    this.clock = options.testHooks?.clock ?? systemClock;
  }

  /** Gives every declared rule its state and schedules the running ones. */
  async start(): Promise<void> {
    for (const profile of this.options.profiles) {
      for (const rule of profile.replayRules) {
        await this.options.state.ensure(ruleKey(profile.name, rule.name), rule.startPaused);
        await this.reschedule(profile, rule);
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
    await Promise.allSettled([...this.running.values()].flatMap((passes) => [...passes]));
    await this.turns.settled();
  }

  /** The rules of `profile`, in file order, with their state, last passes and next pass time. */
  list(profile: BrokerProfile): Promise<ReplayRuleView[]> {
    return Promise.all(
      profile.replayRules.map(async (rule) => {
        const key = ruleKey(profile.name, rule.name);
        const [state, passes] = await Promise.all([this.options.state.ensure(key, rule.startPaused), this.options.state.passes(key)]);
        return { rule, state, passes, nextPassAt: this.timers.get(key)?.at.toISOString() ?? null };
      }),
    );
  }

  /** The state of every declared rule; a rule start() has not seen yet has none and is left out. */
  async states(): Promise<Array<{ profile: string; rule: string; state: RuleState }>> {
    const states = await Promise.all(
      this.options.profiles.flatMap((profile) =>
        profile.replayRules.map(async (rule) => {
          const state = await this.options.state.state(ruleKey(profile.name, rule.name));
          return state ? [{ profile: profile.name, rule: rule.name, state }] : [];
        }),
      ),
    );
    return states.flat();
  }

  /** The rules of the profile paused now; `pausedAt` is null until something paused one, so one deployed `startPaused` is left out. */
  async pausedRules(profile: string): Promise<Array<{ name: string; reason: string | null; pausedAt: number }>> {
    return (await this.states()).flatMap(({ profile: p, rule, state }) =>
      p === profile && state.paused && state.pausedAt !== null ? [{ name: rule, reason: state.pausedReason, pausedAt: Date.parse(state.pausedAt) }] : [],
    );
  }

  /** The rule named `name` of `profile`; throws 404 `replay_rule_not_found`. */
  find(profile: BrokerProfile, name: string): ReplayRule {
    const rule = profile.replayRules.find((r) => r.name === name);
    if (!rule) throw replayRuleNotFound(profile.name, name);
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
    try {
      const { pass, error } = await this.tracked(ruleKey(profile.name, rule.name), this.pass(profile, rule));
      if (error !== undefined) throw error;
      return pass;
    } finally {
      await this.reschedule(profile, rule);
    }
  }

  /**
   * The rule badges of Messages held from `vhost`/`queue`, in the order given: for
   * each, the first running rule of the profile on that queue that matches it; null
   * when none.
   */
  async badges(profile: BrokerProfile, vhost: string, queue: string, held: ReadonlyArray<{ delivery: Delivery; diedAgainCount: number }>): Promise<Array<RuleBadge | null>> {
    const onQueue = profile.replayRules.filter((rule) => rule.vhost === vhost && rule.queue === queue);
    const states = await Promise.all(onQueue.map((rule) => this.options.state.state(ruleKey(profile.name, rule.name))));
    const running = onQueue.filter((rule, i) => !(states[i]?.paused ?? rule.startPaused));
    const ids = held.map(({ delivery }) => messageIdOf(delivery)).filter((id) => id !== null);
    const firstSeen = await Promise.all(running.map((rule) => this.options.state.firstSeenAt(ruleKey(profile.name, rule.name), ids)));
    return held.map(({ delivery, diedAgainCount }) => {
      const messageId = messageIdOf(delivery);
      for (const [i, rule] of running.entries()) {
        const firstSeenAt = messageId === null ? null : (firstSeen[i]!.get(messageId) ?? null);
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
    });
  }

  /**
   * Pauses the rule for `operator` with `reason`: no scheduled passes until an
   * `admin` resumes it. Throws 400 `invalid_request` without a reason, 404
   * `replay_rule_not_found`, 409 `replay_rule_paused` when it is paused already.
   */
  async pause(profile: BrokerProfile, name: string, operator: Operator, role: Role, reason: unknown): Promise<RuleState> {
    const rule = this.find(profile, name);
    if (typeof reason !== 'string' || reason.trim() === '') throw new InvalidRequestError('"reason" must say why the rule is paused.');
    return this.turns.run(ruleKey(profile.name, name), async () => {
      if ((await this.stateOf(profile, rule)).paused) throw replayRulePaused(profile.name, name);
      await this.markPaused(profile, rule, { operator, role }, reason.trim());
      return this.stateOf(profile, rule);
    });
  }

  /**
   * Resumes the paused rule for `operator`, forgetting the Died Again Messages
   * its automatic stop counted. Throws 404 `replay_rule_not_found`, 409
   * `replay_rule_running` when it is not paused.
   */
  async resume(profile: BrokerProfile, name: string, operator: Operator, role: Role): Promise<RuleState> {
    const rule = this.find(profile, name);
    return this.turns.run(ruleKey(profile.name, name), async () => {
      if (!(await this.stateOf(profile, rule)).paused) throw replayRuleRunning(profile.name, name);
      await this.markResumed(profile, rule, { operator, role });
      return this.stateOf(profile, rule);
    });
  }

  /** Schedules the rule's next pass from its last one, or clears it while the rule is paused. */
  private reschedule(profile: BrokerProfile, rule: ReplayRule): Promise<void> {
    return this.turns.run(ruleKey(profile.name, rule.name), () => this.scheduleNext(profile, rule));
  }

  /** Inside the rule's turn, so that two of these cannot each leave a timer. A store that fails does not end the rule: it tries again one `every` later. */
  private async scheduleNext(profile: BrokerProfile, rule: ReplayRule): Promise<void> {
    const key = ruleKey(profile.name, rule.name);
    this.timers.get(key)?.cancel();
    this.timers.delete(key);
    if (this.stopped) return;
    let last: RulePass | undefined;
    try {
      if ((await this.options.state.state(key))?.paused !== false) return;
      last = (await this.options.state.passes(key))[0];
    } catch (err) {
      this.options.onError?.(key, err);
    }
    if (this.stopped) return;
    const now = this.clock.now().getTime();
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
    const key = ruleKey(profile.name, rule.name);
    if (this.stopped || this.running.has(key)) return null;
    let reschedule = true;
    const scheduled = async () => {
      // In the rule's turn: a pause that answered before this read is seen.
      const state = await this.turns.run(key, () => this.options.state.state(key));
      if (this.stopped || state?.paused !== false) {
        reschedule = false;
        return null;
      }
      return (await this.pass(profile, rule)).pass;
    };
    try {
      // Counted as running before its first store call, so a second one finds it.
      return await this.tracked(key, scheduled());
    } finally {
      if (reschedule) await this.reschedule(profile, rule);
    }
  }

  /** Counts `pass` as running until it settles. */
  private async tracked<T>(key: string, pass: Promise<T>): Promise<T> {
    const passes = this.running.get(key) ?? new Set<Promise<unknown>>();
    this.running.set(key, passes);
    passes.add(pass);
    try {
      return await pass;
    } finally {
      passes.delete(pass);
      if (passes.size === 0) this.running.delete(key);
    }
  }

  /** Runs and records one pass; a skip or a refused start is recorded and returned with its error. */
  private async pass(profile: BrokerProfile, rule: ReplayRule): Promise<{ pass: RulePass; error?: unknown }> {
    const key = ruleKey(profile.name, rule.name);
    let error: unknown;
    const now = this.clock.now();
    const { pass, findings } = await runRulePass(this.options.checkouts, profile, rule, {
      now,
      firstSeen: (ids, at) => this.options.state.firstSeen(key, ids, at),
    }).catch((err): { pass: RulePass; findings: null } => {
      error = err;
      const skipped = err instanceof HttpError && (err.code === 'checkout_in_progress' || err.code === 'operator_has_checkout');
      return {
        pass: { id: randomUUID(), at: now.toISOString(), status: skipped ? 'skipped' : 'failed', summary: null, reason: (err as Error).message },
        findings: null,
      };
    });
    await this.options.state.recordPass(key, pass);
    this.options.onPassRecorded?.(profile.name, rule.name, pass);
    await this.turns.run(key, () => this.afterPass(profile, rule, now, findings, error));
    return { pass, error };
  }

  /** The automatic stop, after each recorded pass: `findings` of a pass that ran, or the `error` its Checkout start threw. Inside the rule's turn. */
  private async afterPass(profile: BrokerProfile, rule: ReplayRule, now: Date, findings: RulePassFindings | null, error: unknown): Promise<void> {
    const key = ruleKey(profile.name, rule.name);
    let reason: string | null = null;
    if (findings) {
      const diedAgain = await this.options.state.countDiedAgain(
        key,
        { profile: profile.name, name: rule.name },
        findings.diedAgainEntryIds,
        now,
        new Date(now.getTime() - rule.stopWhen.withinMs),
      );
      if (findings.publishFailure === 'refused') reason = 'broker_permission_denied';
      else if (findings.publishFailure === 'failed') reason = 'publish_failed';
      else if (diedAgain >= rule.stopWhen.diedAgain) reason = 'died_again';
    } else if (error instanceof HttpError && PAUSING_START_ERRORS.has(error.code)) {
      reason = error.code;
    }
    if (reason === null || (await this.stateOf(profile, rule)).paused) return;
    await this.markPaused(profile, rule, { operator: ruleOperator(profile.name, rule.name), role: 'operator' }, reason);
  }

  private stateOf(profile: BrokerProfile, rule: ReplayRule): Promise<RuleState> {
    return this.options.state.ensure(ruleKey(profile.name, rule.name), rule.startPaused);
  }

  /** Pauses the rule for `by` with `reason`, records it as an Audit Entry, and clears its next pass. Inside the rule's turn. */
  private async markPaused(profile: BrokerProfile, rule: ReplayRule, by: RuleActor, reason: string): Promise<void> {
    const at = this.clock.now();
    await this.options.state.setPaused(ruleKey(profile.name, rule.name), { reason, by: by.operator.displayName, at });
    await this.recordPauseOrResume(profile, rule, by, at, { action: 'rule_pause', reason });
    await this.scheduleNext(profile, rule);
    await this.options.onPauseChanged?.(profile.name);
  }

  /** Resumes the rule for `by`, clearing the automatic stop's count; records it as an Audit Entry and schedules its next pass. Inside the rule's turn. */
  private async markResumed(profile: BrokerProfile, rule: ReplayRule, by: RuleActor): Promise<void> {
    const key = ruleKey(profile.name, rule.name);
    const at = this.clock.now();
    await this.options.state.setPaused(key, null);
    await this.options.state.clearDiedAgain(key);
    await this.recordPauseOrResume(profile, rule, by, at, { action: 'rule_resume', reason: null });
    await this.scheduleNext(profile, rule);
    await this.options.onPauseChanged?.(profile.name);
  }

  /** The Audit Entry of a pause or resume: no Message, the rule named, done at once. */
  private async recordPauseOrResume(
    profile: BrokerProfile,
    rule: ReplayRule,
    by: RuleActor,
    at: Date,
    { action, reason }: { action: 'rule_pause' | 'rule_resume'; reason: string | null },
  ): Promise<void> {
    const entryId = await this.options.audit.record({
      at,
      operator: by.operator,
      role: by.role,
      // A rule runs on a profile with shared credentials only (config.ts).
      brokerUser: sharedBrokerUser(profile) ?? '',
      profile: profile.name,
      vhost: rule.vhost,
      queue: rule.queue,
      messageId: null,
      action,
      reason,
      destination: null,
      checkoutId: null,
      message: null,
      rule: rule.name,
    });
    await this.options.audit.setOutcome(entryId, 'done');
  }
}
