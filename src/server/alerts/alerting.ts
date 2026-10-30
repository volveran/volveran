// Runs Alert evaluation after each sampling run and on each Replay Rule pause or
// resume: reads what is remembered from
// the audit store, stores the result, then hands the notifications to the
// notifier without waiting for them. Stored first, so a crash in between loses a
// notification rather than sending one again after the restart.
import type { AlertStore } from '../audit/alerts.js';
import type { FinishedRun } from '../history/sampler.js';
import type { BrokerProfile } from '../profiles.js';
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
  pausedReplayRules(profile: string): PausedReplayRule[];
  /** When the profile last ran well; null when it never has. */
  lastSuccessAt(profile: string): Date | null;
  /** A notification could not be handed over. */
  onError?(err: unknown): void;
}

export class Alerting {
  private readonly profiles: Map<string, BrokerProfile>;

  constructor(private readonly options: AlertingOptions) {
    this.profiles = new Map(options.profiles.map((p) => [p.name, p]));
    // Alerts of rules no longer in the file go now, with no resolved notification.
    options.store.keepOnly(new Map(options.profiles.map((p) => [p.name, p.alerts.map((r) => r.name)])));
  }

  /** After a sampling run. */
  evaluate(run: FinishedRun): void {
    this.run(run.samplingRun.profile, run.samplingRun.at, run);
  }

  /** On a Replay Rule's pause or resume, in the middle of what caused it: never throws. */
  replayRuleChanged(profile: string): void {
    try {
      this.run(profile, this.options.clock.now(), null);
    } catch (err) {
      this.options.onError?.(err);
    }
  }

  private run(name: string, at: Date, run: FinishedRun | null): void {
    const { store, notifier, onError, pausedReplayRules, lastSuccessAt } = this.options;
    const profile = this.profiles.get(name);
    if (!profile || profile.alerts.length === 0) return;
    const { memory, notifications } = evaluateAlerts({
      profile: profile.name,
      rules: profile.alerts,
      memory: store.load(profile.name),
      at,
      run,
      pausedReplayRules: pausedReplayRules(name),
      lastSuccessAt: lastSuccessAt(name),
    });
    store.save(profile.name, memory);
    for (const { destinations, notification } of notifications) {
      for (const destination of destinations) notifier.send(destination, notification).catch((err) => onError?.(err));
    }
  }
}
