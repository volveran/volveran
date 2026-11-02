// The queue sampler, a job on the Background Leader (ADR 0014), so only the leader
// reads the broker and records Samples: every
// VOLVERAN_HISTORY_INTERVAL_SECONDS it reads the vhosts of each shared-credentials
// Broker Profile through the management API and records one Sample per
// dead-letter queue. It never takes a Checkout or reads a Message.
//
// - Profiles are sampled concurrently and independently. A profile whose run is
//   still going is left out of the next tick, and never delays the others.
// - A run is all or nothing per profile: if any of its vhosts cannot be read,
//   the run is recorded as failed with the error's code and no Samples.
// - A queue the management API lists with no depth (just after a broker restart,
//   docs/rabbitmq-behaviour.md) gets no Sample in that run: its depth is unknown,
//   not 0. A queue a good run did not sample has unknown arrivals at its next
//   Sample, so its depth coming back is no spike.
// - `operatorToken` profiles are not sampled: nobody is signed in to lend a
//   token (ADR 0008).
// - The first run comes one interval after start().
// - The Messages taken out come from the Audit Entries in the store, so they
//   include those taken out through every Replica. A change of leader takes
//   the depth before from the store too, and its missing runs show as a gap.
// - Its write names the lease. A former leader's run is refused, records nothing
//   and reaches no subscriber.
//
// Metrics and Alert evaluation read only this module's latest snapshot, or
// subscribe with onRun(); neither touches the broker or the history tables.
import { brokerCredentials } from '../broker-credentials.js';
import { BrokerError } from '../broker-error.js';
import type { HistoryStore, LeaseFence, QueueSample } from '../audit/audit-store.js';
import type { LeaderJob } from '../leader/background-leader.js';
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
  /** The depth of the Sample before; null on the queue's first Sample, or when the latest good run did not sample it. */
  previousDepth: number | null;
  /** The Messages Volverán took out since the Sample before, by their Audit Entries. */
  takenOut: number;
  /** Since the Sample before; null when unknown (the queue's first Sample, or the first after a good run missed it). */
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
   * old `at`, as does a queue a good run had no depth for, and a deleted queue
   * leaves at the next good run. Empty after a
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
  samplingRun: SamplingRun;
  /** This run's Samples, each once; empty when the run failed. */
  samples: LatestSample[];
  /** The dead-letter queues this run read but had no depth for, so no Sample: nothing is known of them, not that they emptied. */
  unknownDepth: Array<{ vhost: string; queue: string }>;
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

export class QueueSampler implements LeaderJob {
  readonly name = 'sampler';
  /** A store that cannot say what was last sampled has always stopped startup. */
  readonly mustStart = true;
  private readonly clock: RuleClock;
  private readonly sampled: BrokerProfile[];
  private readonly snapshots = new Map<string, ProfileSnapshot>();
  private readonly running = new Map<string, Promise<SamplingRun | null>>();
  private readonly listeners = new Set<RunListener>();
  private timer: { cancel(): void } | null = null;
  private stopped = false;
  private fence: LeaseFence | undefined;

  constructor(private readonly options: QueueSamplerOptions) {
    this.clock = options.testHooks?.clock ?? systemClock;
    this.sampled = options.profiles.filter(isSampled);
  }

  /** May be called again after stop(): each start reads what is known from the store. */
  async start(fence: LeaseFence): Promise<void> {
    this.stopped = false;
    this.fence = fence;
    await Promise.all(
      this.sampled.map(async ({ name }) => {
        const { last, lastOk } = await this.options.history.lastRuns(name);
        this.snapshots.set(name, {
          profile: name,
          lastRun: last && { profile: name, at: new Date(last.at), ok: last.ok, errorCode: last.errorCode },
          lastSuccessAt: lastOk && new Date(lastOk.at),
          queues: [],
        });
      }),
    );
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
      // begin never rejects, and each profile is sampled at its own pace.
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

    const samples = run.ok ? await this.toSamples(profile.name, at, readings) : [];
    const unknownDepth = readings.flatMap(({ vhost, queues }) => queues.filter((q) => q.depthMissing).map((q) => ({ vhost, queue: q.name })));
    await this.options.history.recordRun(profile.name, { at: at.getTime(), ok: run.ok, errorCode: run.errorCode, intervalMs: this.options.intervalMs }, samples.map(toStored), this.fence);

    const previous = this.snapshots.get(profile.name);
    this.snapshots.set(profile.name, {
      profile: profile.name,
      lastRun: run,
      lastSuccessAt: run.ok ? at : (previous?.lastSuccessAt ?? null),
      queues: run.ok ? [...samples, ...(previous?.queues ?? []).filter((q) => unknownDepth.some((u) => u.vhost === q.vhost && u.queue === q.queue))] : (previous?.queues ?? []),
    });

    const settled = await Promise.allSettled([...this.listeners].map(async (listener) => listener({ samplingRun: run, samples, unknownDepth })));
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
        const queues = reading.queues.filter((q) => q.deadLetterQueue).map((q) => ({ ...q, depthMissing: reading.depthMissing.has(q.name) }));
        return { vhost, queues };
      }),
    );
  }

  private async toSamples(profile: string, at: Date, readings: Awaited<ReturnType<QueueSampler['read']>>): Promise<LatestSample[]> {
    const { history } = this.options;
    const lastGoodRun = await history.lastGoodRunBefore(profile, at.getTime());
    const read = readings.flatMap(({ vhost, queues }) =>
      queues.filter((q) => !q.depthMissing).map(async (q): Promise<LatestSample> => {
        const ref = { profile, vhost, queue: q.name };
        const latest = await history.latestSample(ref, at.getTime());
        // A good run since this queue's latest Sample did not sample it: what happened in between is unknown.
        const previous = latest && lastGoodRun !== null && lastGoodRun > latest.at ? null : latest;
        const takenOut = previous ? await history.takenOut(ref, previous.at, at.getTime()) : 0;
        return {
          ...ref,
          at,
          depth: q.approximateMessages,
          previousDepth: previous?.depth ?? null,
          takenOut,
          estimatedArrivals: estimateArrivals({ previousDepth: previous?.depth ?? null, depth: q.approximateMessages, takenOut }),
          setupWarnings: q.setupWarnings,
        };
      }),
    );
    return Promise.all(read);
  }
}

function toStored(s: LatestSample): QueueSample {
  return { vhost: s.vhost, queue: s.queue, at: s.at.getTime(), depth: s.depth, estimatedArrivals: s.estimatedArrivals };
}
