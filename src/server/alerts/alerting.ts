// Runs Alert evaluation after each sampling run and on each Replay Rule pause or
// resume: reads what is remembered from
// the audit store, stores the result, then hands the notifications to the
// notifier without waiting for them. Stored first, so a crash in between loses a
// notification rather than sending one again after the restart.
//
// Load, evaluate and save are one turn per profile: a store call is an interleave
// point (ADR 0013), and two evaluations on the same memory would lose one's result
// and send its notifications twice.
import type { AlertStore } from '../audit/audit-store.js';
import type { FinishedRun } from '../history/sampler.js';
import type { BrokerProfile } from '../profiles.js';
import { OneAtATime } from '../one-at-a-time.js';
import type { RuleClock } from '../replay-rules/rule-clock.js';
import { evaluateAlerts, type PausedReplayRule } from './evaluation.js';
import type { Notifier } from './notifier.js';

export interface AlertingOptions {
  profiles: readonly BrokerProfile[];
  store: AlertStore;
  notifier: Pick<Notifier, 'send'>;
  /** The time of an evaluation on a pause or resume; a run has its own. */
  clock: Pick<RuleClock, 'now'>;
  /** The Replay Rules of the profile paused now; one deployed `startPaused` and not paused since is not among them. */
  pausedReplayRules(profile: string): Promise<PausedReplayRule[]>;
  /** When the profile last ran well; null when it never has. */
  lastSuccessAt(profile: string): Date | null;
  /** A notification could not be handed over. */
  onError?(err: unknown): void;
}

export class Alerting {
  private readonly profiles: Map<string, BrokerProfile>;
  private readonly perProfile = new OneAtATime();
  private stopped = false;

  constructor(private readonly options: AlertingOptions) {
    this.profiles = new Map(options.profiles.map((p) => [p.name, p]));
  }

  /** Alerts of rules no longer in the file go now, with no resolved notification. Before anything evaluates. */
  async start(): Promise<void> {
    const { profiles, store } = this.options;
    await store.keepOnly(new Map(profiles.map((p) => [p.name, p.alerts.map((r) => r.name)])));
  }

  /** No evaluation starts after this, and those in progress have ended when it resolves. */
  async stop(): Promise<void> {
    this.stopped = true;
    await this.perProfile.settled();
  }

  /** After a sampling run. */
  evaluate(run: FinishedRun): Promise<void> {
    return this.run(run.samplingRun.profile, run.samplingRun.at, run);
  }

  /** On a Replay Rule's pause or resume, in the middle of what caused it: never rejects. */
  async replayRuleChanged(profile: string): Promise<void> {
    try {
      await this.run(profile, this.options.clock.now(), null);
    } catch (err) {
      this.options.onError?.(err);
    }
  }

  private run(name: string, at: Date, run: FinishedRun | null): Promise<void> {
    const profile = this.profiles.get(name);
    if (!profile || profile.alerts.length === 0 || this.stopped) return Promise.resolve();
    return this.perProfile.run(name, () => this.evaluateProfile(profile, at, run));
  }

  private async evaluateProfile(profile: BrokerProfile, at: Date, run: FinishedRun | null): Promise<void> {
    const { store, notifier, onError, pausedReplayRules, lastSuccessAt } = this.options;
    const [memory, paused] = await Promise.all([store.load(profile.name), pausedReplayRules(profile.name)]);
    const evaluated = evaluateAlerts({
      profile: profile.name,
      rules: profile.alerts,
      memory,
      at,
      run,
      pausedReplayRules: paused,
      lastSuccessAt: lastSuccessAt(profile.name),
    });
    await store.save(profile.name, evaluated.memory);
    const { notifications } = evaluated;
    for (const { destinations, notification } of notifications) {
      for (const destination of destinations) notifier.send(destination, notification).catch((err) => onError?.(err));
    }
  }
}
