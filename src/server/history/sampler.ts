// The queue sampler, owned by the server like the Replay Rules scheduler: every
// VOLVERAN_HISTORY_INTERVAL_SECONDS it reads the vhosts of each shared-credentials
// Broker Profile through the management API and records one Sample per
// dead-letter queue. It never takes a Checkout or reads a Message.
//
// - Profiles are sampled concurrently and independently. A profile whose run is
//   still going is left out of the next tick, and never delays the others.
// - A run is all or nothing per profile: if any of its vhosts cannot be read,
//   the run is recorded as failed with the error's code and no Samples.
// - `operatorToken` profiles are not sampled: nobody is signed in to lend a
//   token (ADR 0008).
// - The first run comes one interval after start().
//
// Metrics and Alert evaluation read only this module's latest snapshot, or
// subscribe with onRun(); neither touches the broker or the history tables.
import { brokerCredentials } from '../broker-credentials.js';
import { BrokerError } from '../broker-error.js';
import type { HistoryStore, QueueSample } from '../audit/history.js';
import { ManagementClient } from '../management.js';
import type { BrokerProfile } from '../profiles.js';
import { systemClock, type RuleClock } from '../replay-rules/rule-clock.js';
import { readVhost } from '../triage/vhost-reading.js';
import type { SetupWarning } from '../../shared/queues.js';
import { estimateArrivals } from './estimated-arrivals.js';

/** One sampling run of one Broker Profile. */
export interface SamplingRun {
  profile: string;
  at: Date;
  ok: boolean;
  /** Why it failed (a BrokerError's code, else `internal_error`); null on a good run. */
  errorCode: string | null;
}

/** The latest Sample of one dead-letter queue, with its set-up warnings from the same reading. */
export interface LatestSample {
  profile: string;
  vhost: string;
  queue: string;
  at: Date;
  depth: number;
  /** Since the Sample before; null when unknown (the queue's first Sample). */
  estimatedArrivals: number | null;
  setupWarnings: SetupWarning[];
}

/** What is known about one sampled Broker Profile. */
export interface ProfileSnapshot {
  profile: string;
  /** Its latest run; null until it has ever run. Kept across a restart. */
  lastRun: SamplingRun | null;
  /** When it last ran well; null when it never has. Kept across a restart. */
  lastSuccessAt: Date | null;
  /**
   * The queues of its latest good run: after a failed run they stay, with their
   * old `at`, and a deleted queue leaves at the next good run. Empty after a
   * restart until the first good run, since set-up warnings are not stored.
   */
  queues: LatestSample[];
}

/** The sampled Broker Profiles, in file order; `operatorToken` profiles are absent. */
export interface LatestSnapshot {
  profiles: ProfileSnapshot[];
}

/** A run that has been recorded, as subscribers get it. */
export interface FinishedRun {
  run: SamplingRun;
  /** This run's Samples, each once; empty when the run failed. */
  samples: LatestSample[];
}

/** May return a promise: "sample now" resolves after it settles, and the profile's next run waits for it. */
export type RunListener = (finished: FinishedRun) => void | Promise<void>;

/** What a test can do to the sampler. */
export interface SamplerControl {
  /** Runs every sampled profile at once, as the timer would; resolves when each run is recorded and its subscribers have settled. */
  sampleNow(): Promise<SamplingRun[]>;
  latest(): LatestSnapshot;
  onRun(listener: RunListener): () => void;
}

export interface SamplerTestHooks {
  /** Replaces the wall clock and timers. */
  clock?: RuleClock;
  /** Receives the sampler's control once it has started. */
  sampler?(control: SamplerControl): void;
}

export interface QueueSamplerOptions {
  profiles: readonly BrokerProfile[];
  history: HistoryStore;
  intervalMs: number;
  testHooks?: SamplerTestHooks;
  /** Recording a run, or a subscriber, broke unexpectedly (a broker's refusal is a failed run, not this). */
  onError?(profile: string, err: unknown): void;
}

/** Whether a Broker Profile can be sampled: there has to be a credential to use with nobody signed in. */
export function isSampled(profile: BrokerProfile): boolean {
  return profile.credentials.kind === 'shared';
}

/** The sampler's identity for credentials; only `operatorToken` profiles would use it, and those are not sampled. */
const SAMPLER = { id: 'volveran-sampler', displayName: 'Volverán sampler' };

export class QueueSampler {
  private readonly clock: RuleClock;
  private readonly sampled: BrokerProfile[];
  private readonly snapshots = new Map<string, ProfileSnapshot>();
  private readonly running = new Map<string, Promise<SamplingRun | null>>();
  private readonly listeners = new Set<RunListener>();
  private timer: { cancel(): void } | null = null;
  private stopped = false;

  constructor(private readonly options: QueueSamplerOptions) {
    this.clock = options.testHooks?.clock ?? systemClock;
    this.sampled = options.profiles.filter(isSampled);
  }

  start(): void {
    for (const { name } of this.sampled) {
      const { last, lastOk } = this.options.history.lastRuns(name);
      this.snapshots.set(name, {
        profile: name,
        lastRun: last && { profile: name, at: new Date(last.at), ok: last.ok, errorCode: last.errorCode },
        lastSuccessAt: lastOk && new Date(lastOk.at),
        queues: [],
      });
    }
    this.schedule();
    this.options.testHooks?.sampler?.({
      sampleNow: () => this.sampleNow(),
      latest: () => this.latest(),
      onRun: (listener) => this.onRun(listener),
    });
  }

  /** Cancels the timer and waits for the runs in progress; nothing is recorded after it resolves. */
  async stop(): Promise<void> {
    this.stopped = true;
    this.timer?.cancel();
    this.timer = null;
    await Promise.allSettled([...this.running.values()]);
  }

  /** The latest Sample per queue and the state of each sampled profile. Reads memory only. */
  latest(): LatestSnapshot {
    return { profiles: this.sampled.map((p) => this.snapshots.get(p.name)!).filter(Boolean) };
  }

  /** Calls `listener` after each recorded run of each profile; returns how to unsubscribe. */
  onRun(listener: RunListener): () => void {
    this.listeners.add(listener);
    return () => void this.listeners.delete(listener);
  }

  private schedule(): void {
    this.timer = this.clock.setTimer(() => {
      if (this.stopped) return;
      for (const profile of this.sampled) if (!this.running.has(profile.name)) void this.begin(profile);
      this.schedule();
    }, this.options.intervalMs);
  }

  private async sampleNow(): Promise<SamplingRun[]> {
    const runs = await Promise.all(
      this.sampled.map(async (profile) => {
        await this.running.get(profile.name);
        return this.begin(profile);
      }),
    );
    return runs.filter((run): run is SamplingRun => run !== null);
  }

  /** Runs the profile once; never rejects. */
  private begin(profile: BrokerProfile): Promise<SamplingRun | null> {
    const run = this.runProfile(profile)
      .catch((err) => {
        this.options.onError?.(profile.name, err);
        return null;
      })
      .finally(() => this.running.delete(profile.name));
    this.running.set(profile.name, run);
    return run;
  }

  private async runProfile(profile: BrokerProfile): Promise<SamplingRun | null> {
    const at = this.clock.now();
    let run: SamplingRun = { profile: profile.name, at, ok: true, errorCode: null };
    let readings: Awaited<ReturnType<QueueSampler['read']>> = [];
    try {
      readings = await this.read(profile);
    } catch (err) {
      run = { ...run, ok: false, errorCode: err instanceof BrokerError ? err.code : 'internal_error' };
    }
    if (this.stopped) return null;

    const samples = run.ok ? this.toSamples(profile.name, at, readings) : [];
    this.options.history.recordRun(profile.name, { at: at.getTime(), ok: run.ok, errorCode: run.errorCode }, samples.map(toStored));

    const previous = this.snapshots.get(profile.name);
    this.snapshots.set(profile.name, {
      profile: profile.name,
      lastRun: run,
      lastSuccessAt: run.ok ? at : (previous?.lastSuccessAt ?? null),
      queues: run.ok ? samples : (previous?.queues ?? []),
    });

    const settled = await Promise.allSettled([...this.listeners].map(async (listener) => listener({ run, samples })));
    for (const result of settled) {
      if (result.status === 'rejected') this.options.onError?.(profile.name, result.reason);
    }
    return run;
  }

  /** The dead-letter queues of every vhost of the profile, read once. */
  private async read(profile: BrokerProfile) {
    const management = new ManagementClient(profile, () => brokerCredentials(profile, SAMPLER));
    const vhosts = profile.vhosts === 'all' ? await management.listVhosts() : profile.vhosts;
    return Promise.all(
      vhosts.map(async (vhost) => {
        const reading = await readVhost({ profile, management }, vhost);
        return { vhost, queues: reading.queues.filter((q) => q.deadLetterQueue) };
      }),
    );
  }

  private toSamples(profile: string, at: Date, readings: Awaited<ReturnType<QueueSampler['read']>>): LatestSample[] {
    const { history } = this.options;
    return readings.flatMap(({ vhost, queues }) =>
      queues.map((q): LatestSample => {
        const ref = { profile, vhost, queue: q.name };
        const previous = history.latestSample(ref, at.getTime());
        const takenOut = previous ? history.takenOut(ref, previous.at, at.getTime()) : 0;
        return {
          ...ref,
          at,
          depth: q.approximateMessages,
          estimatedArrivals: estimateArrivals({ previousDepth: previous?.depth ?? null, depth: q.approximateMessages, takenOut }),
          setupWarnings: q.setupWarnings,
        };
      }),
    );
  }
}

function toStored(s: LatestSample): QueueSample {
  return { vhost: s.vhost, queue: s.queue, at: s.at.getTime(), depth: s.depth, estimatedArrivals: s.estimatedArrivals };
}
