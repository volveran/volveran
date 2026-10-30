// Runs Alert evaluation after each sampling run: reads what is remembered from
// the audit store, stores the result, then hands the notifications to the
// notifier without waiting for them. Stored first, so a crash in between loses a
// notification rather than sending one again after the restart.
import type { AlertStore } from '../audit/alerts.js';
import type { FinishedRun } from '../history/sampler.js';
import type { BrokerProfile } from '../profiles.js';
import { evaluateAlerts } from './evaluation.js';
import type { Notifier } from './notifier.js';

export interface AlertingOptions {
  profiles: readonly BrokerProfile[];
  store: AlertStore;
  notifier: Pick<Notifier, 'send'>;
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

  evaluate(run: FinishedRun): void {
    const { store, notifier, onError } = this.options;
    const profile = this.profiles.get(run.run.profile);
    if (!profile || profile.alerts.length === 0) return;
    const { memory, notifications } = evaluateAlerts({ profile: profile.name, rules: profile.alerts, memory: store.load(profile.name), run });
    store.save(profile.name, memory);
    for (const { destinations, notification } of notifications) {
      for (const destination of destinations) notifier.send(destination, notification).catch((err) => onError?.(err));
    }
  }
}
