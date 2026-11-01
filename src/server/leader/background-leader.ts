// The Background Leader (ADR 0014): one Replica at a time holds a lease in the audit
// store and runs the jobs that must run once however many Replicas there are. Every
// Replica keeps claiming the lease; the one that gets it starts the jobs, and stops them
// when it finds it has lost it, when it cannot renew in time, or when it stops.
//
// To move work onto the leader, give BackgroundLeader a LeaderJob. A job may start and
// stop many times in one process. Its writes that must not come from a former leader
// name the fence it is started with, and the store refuses them once the lease has moved.
import { randomUUID } from 'node:crypto';
import type { LeaderLeaseGrant, LeaderLeaseStore, LeaseFence } from '../audit/audit-store.js';
import { OneAtATime } from '../one-at-a-time.js';
import { systemClock, type RuleClock } from '../replay-rules/rule-clock.js';

/** How long a claim holds the lease. */
export const LEADER_LEASE_MS = 15_000;
/** How often every Replica claims it: the leader to renew, the others to take over. */
export const LEADER_RENEW_MS = 5_000;
/** The stated time: at most this long after the leader goes silently, another holds the lease. A leader that shuts down gives it up, and it moves within LEADER_RENEW_MS. */
export const LEADER_TAKEOVER_MS = LEADER_LEASE_MS + LEADER_RENEW_MS;

export interface LeaderJob {
  /** For logs. */
  name: string;
  /** Runs while this Replica is the leader. `start` may do its first run before it answers: renewal does not wait for it. */
  start(fence: LeaseFence): Promise<void>;
  /** Ends the job's work and whatever it has in progress. */
  stop(): Promise<void>;
}

export interface LeaderTiming {
  leaseMs: number;
  renewMs: number;
}

/** What a test can do to the leader. */
export interface LeaderControl {
  readonly isLeader: boolean;
  /** Claims the lease at once, as the timer would. */
  claimNow(): Promise<void>;
}

export interface LeaderTestHooks {
  /** Replaces the wall clock and timers, of the leader and of the jobs on it. */
  clock?: RuleClock;
  /** Replaces how long a claim lasts and how often it is made. */
  timing?: Partial<LeaderTiming>;
  /** Receives the leader's control once it exists. */
  leader?(control: LeaderControl): void;
}

export interface BackgroundLeaderOptions {
  lease: LeaderLeaseStore;
  jobs: readonly LeaderJob[];
  clock?: RuleClock;
  timing?: Partial<LeaderTiming>;
  /** A claim or a job failed. Never stops the leader. */
  onError(err: unknown, job?: string): void;
  /** Told of each change, when the jobs have started or stopped. */
  onChange?(isLeader: boolean): void;
}

export class BackgroundLeader implements LeaderControl {
  /** Who claims. A new one per process, so a restart is never taken for the Replica it was. */
  readonly holder = randomUUID();
  private readonly lease: LeaderLeaseStore;
  private readonly jobs: readonly LeaderJob[];
  private readonly clock: RuleClock;
  private readonly leaseMs: number;
  private readonly renewMs: number;
  private readonly onError: BackgroundLeaderOptions['onError'];
  private readonly onChange: BackgroundLeaderOptions['onChange'];
  /** Jobs start and stop one change at a time, and a claim never waits for them. */
  private readonly changes = new OneAtATime();
  private stopping = false;
  private term: number | null = null;
  private renewTimer: { cancel(): void } | null = null;
  private expiryTimer: { cancel(): void } | null = null;
  private claiming: Promise<void> | null = null;

  constructor(options: BackgroundLeaderOptions) {
    this.lease = options.lease;
    this.jobs = options.jobs;
    this.clock = options.clock ?? systemClock;
    this.leaseMs = options.timing?.leaseMs ?? LEADER_LEASE_MS;
    this.renewMs = options.timing?.renewMs ?? LEADER_RENEW_MS;
    this.onError = options.onError;
    this.onChange = options.onChange;
  }

  get isLeader(): boolean {
    return this.term !== null;
  }

  /** Makes the first claim. If it wins, answers when the jobs have started, so what they do first is done before the app listens. */
  async start(): Promise<void> {
    await this.claimNow();
    await this.changes.settled();
  }

  /** Claims the lease now and sets the next claim. Claims never overlap. */
  claimNow(): Promise<void> {
    this.claiming ??= this.claim().finally(() => {
      this.claiming = null;
    });
    return this.claiming;
  }

  /** Stops the jobs, then gives the lease up. Never rejects. */
  async stop(): Promise<void> {
    this.stopping = true;
    this.renewTimer?.cancel();
    this.expiryTimer?.cancel();
    await this.claiming;
    const wasLeader = this.isLeader;
    this.lost();
    await this.changes.settled();
    if (!wasLeader) return;
    try {
      await this.lease.release(this.holder);
    } catch (err) {
      // It runs out on its own.
      this.onError(err);
    }
  }

  private async claim(): Promise<void> {
    try {
      const grant = await this.lease.claim(this.holder, this.clock.now().getTime(), this.leaseMs);
      if (this.stopping) return;
      if (grant) this.held(grant);
      else this.lost();
    } catch (err) {
      // The lease may still be ours: the expiry timer decides.
      this.onError(err);
    }
    if (!this.stopping) {
      this.renewTimer?.cancel();
      this.renewTimer = this.clock.setTimer(() => void this.claimNow(), this.renewMs);
    }
  }

  private held({ holder, term }: LeaderLeaseGrant): void {
    this.expiryTimer?.cancel();
    this.expiryTimer = this.clock.setTimer(() => this.lost(), this.leaseMs);
    if (this.term === term) return;
    // The lease went to another and came back between two claims: the jobs hold a stale fence.
    this.lost();
    this.expiryTimer = this.clock.setTimer(() => this.lost(), this.leaseMs);
    this.term = term;
    void this.changes.run('jobs', () => this.startJobs({ holder, term }));
  }

  private lost(): void {
    this.expiryTimer?.cancel();
    if (this.term === null) return;
    this.term = null;
    void this.changes.run('jobs', () => this.stopJobs());
  }

  private async startJobs(fence: LeaseFence): Promise<void> {
    for (const job of this.jobs) {
      try {
        await job.start(fence);
      } catch (err) {
        this.onError(err, job.name);
      }
    }
    this.onChange?.(true);
  }

  private async stopJobs(): Promise<void> {
    for (const job of [...this.jobs].reverse()) {
      try {
        await job.stop();
      } catch (err) {
        this.onError(err, job.name);
      }
    }
    this.onChange?.(false);
  }
}
