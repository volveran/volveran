// Runs Alert evaluation after each sampling run and on each Replay Rule pause or
// resume, as a job on the Background Leader: on any other Replica both do nothing, so
// there is one notification per Alert. It reads what is remembered from the audit
// store, stores the result with its notifications, then hands them to the notifier
// without waiting for them. Stored first, so nothing is sent for a result the store
// refused from a former leader (ADR 0014).
//
// A notification is forgotten once its delivery has ended. One a leader did not get to
// finish is sent by the next, so a notification in flight when a leader dies may be
// sent twice. On SQLite a restart forgets them, and a crash between storing and sending
// loses the notification.
//
// Load, evaluate and save are one turn per profile: a store call is an interleave
// point (ADR 0013), and two evaluations on the same memory would lose one's result
// and send its notifications twice.
import { LeaderLeaseLost, type AlertStore, type LeaseFence, type OutgoingNotification } from '../audit/audit-store.js';
import type { FinishedRun } from '../history/sampler.js';
import type { LeaderJob } from '../leader/background-leader.js';
import type { BrokerProfile } from '../profiles.js';
import { OneAtATime } from '../one-at-a-time.js';
import type { RuleClock } from '../replay-rules/rule-clock.js';
import { evaluateAlerts, type PausedReplayRule } from './evaluation.js';
import { SERVER_STOPPING, type Notifier } from './notifier.js';

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
  /** The store refused a write: this Replica is no longer the leader, and wrote nothing. */
  onLeaseLost?(): void;
}

/** The key of what comes before a term's first evaluation; no profile has an empty name. */
const PREPARING = '';

export class Alerting implements LeaderJob {
  readonly name = 'alerting';
  private readonly profiles: Map<string, BrokerProfile>;
  private readonly oneAtATime = new OneAtATime();
  /** Set while this Replica is the leader. */
  private fence: LeaseFence | null = null;
  /** Whether this term's first evaluation may go ahead. */
  private prepared = false;
  private startFailure: unknown = null;
  private readonly deliveries = new Map<number, Promise<void>>();

  constructor(private readonly options: AlertingOptions) {
    this.profiles = new Map(options.profiles.map((p) => [p.name, p]));
  }

  /**
   * From here this Replica evaluates. Alerts of rules no longer in the file go now, with
   * no resolved notification, and what a former leader left unsent goes out. If that
   * fails it is tried again before each evaluation, so a leader never sits without
   * Alerts for its whole term because the store failed once.
   */
  async start(fence: LeaseFence): Promise<void> {
    this.fence = fence;
    this.prepared = false;
    this.startFailure = null;
    try {
      await this.prepare(fence);
    } catch (err) {
      if (err instanceof LeaderLeaseLost) {
        this.options.onLeaseLost?.();
        return;
      }
      this.startFailure = err;
      throw err;
    }
  }

  /** Throws what the last start failed with, for a startup that should fail with it. */
  throwStartFailure(): void {
    if (this.startFailure !== null) throw this.startFailure;
  }

  /** No evaluation starts after this, and those in progress have ended when it resolves. Deliveries in progress carry on. */
  async stop(): Promise<void> {
    this.fence = null;
    await this.oneAtATime.settled();
  }

  /** Resolves when no delivery has anything left to tell the store. Once the notifier has closed. */
  async drained(): Promise<void> {
    await Promise.allSettled(this.deliveries.values());
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

  private prepare(fence: LeaseFence): Promise<void> {
    return this.oneAtATime.run(PREPARING, async () => {
      if (this.prepared) return;
      await this.tidyAndResend(fence);
      this.prepared = true;
    });
  }

  private async tidyAndResend(fence: LeaseFence): Promise<void> {
    const { profiles, store } = this.options;
    await store.keepOnly(new Map(profiles.map((p) => [p.name, p.alerts.map((r) => r.name)])), fence);
    for (const { id, profile, destination, notification } of await store.unsent()) {
      if (this.deliveries.has(id)) continue;
      const rule = this.profiles.get(profile)?.alerts.find((r) => r.name === notification.rule);
      if (rule?.destinations.includes(destination)) this.deliver(id, { destination, notification });
      // Its rule has left the file, and its Alerts with it, quietly.
      else await store.ended(id);
    }
  }

  private run(name: string, at: Date, run: FinishedRun | null): Promise<void> {
    const profile = this.profiles.get(name);
    const { fence } = this;
    if (!profile || profile.alerts.length === 0 || fence === null) return Promise.resolve();
    return this.oneAtATime.run(name, async () => {
      try {
        await this.prepare(fence);
        await this.evaluateProfile(profile, at, run, fence);
      } catch (err) {
        if (err instanceof LeaderLeaseLost) this.options.onLeaseLost?.();
        else throw err;
      }
    });
  }

  private async evaluateProfile(profile: BrokerProfile, at: Date, run: FinishedRun | null, fence: LeaseFence): Promise<void> {
    const { store, pausedReplayRules, lastSuccessAt } = this.options;
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
    const outgoing = evaluated.notifications.flatMap(({ destinations, notification }) => destinations.map((destination) => ({ destination, notification })));
    const ids = await store.save(profile.name, evaluated.memory, outgoing, fence);
    outgoing.forEach((o, i) => this.deliver(ids[i]!, o));
  }

  /** A delivery the server's stop cut short stays unsent, for the next leader. */
  private deliver(id: number, { destination, notification }: OutgoingNotification): void {
    const { store, notifier, onError } = this.options;
    const delivery = notifier
      .send(destination, notification)
      .then(async ({ error }) => {
        if (error !== SERVER_STOPPING) await store.ended(id);
      })
      .catch((err: unknown) => onError?.(err))
      .finally(() => this.deliveries.delete(id));
    this.deliveries.set(id, delivery);
  }
}
