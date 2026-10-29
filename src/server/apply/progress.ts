// The progress of an Apply as it runs in the background: its steps counted
// by outcome, and when it should end at its pace so far. The executor
// records each step's outcome here; the Checkout view shows it
// (`applyProgress`). Pacing (a Replay Rate) and a stop by an Operator fill
// `rate` and `stoppedBy`.
import type { ApplyPhase, ApplyProgress, OutcomeStatus } from '../../shared/checkout.js';

export type { ApplyProgress };

export class ApplyProgressTracker {
  private done = 0;
  private failed = 0;
  private notAttempted = 0;
  /** When the last step settled, once none remains. */
  private endedAt: Date | null = null;
  /** When the last attempted (done or failed) step settled. */
  private lastAttemptAt: Date | null = null;
  /** The Operator who stopped the Apply (display name); null unless one did. */
  stoppedBy: string | null = null;
  /** Running, or waiting after a Canary (checkout/canary.ts sets it). */
  phase: ApplyPhase = 'running';

  constructor(
    /** The Apply's steps: every Decision other than Keep. */
    readonly total: number,
    readonly startedAt: Date,
    /** The Replay Rate, in Messages per second; null when there is none. */
    readonly rate: number | null = null,
  ) {}

  /** One step settled with `status` (kept Messages are not steps). */
  record(status: Exclude<OutcomeStatus, 'kept'>, at: Date = new Date()): void {
    if (status === 'done') this.done++;
    else if (status === 'failed') this.failed++;
    else this.notAttempted++;
    if (status !== 'not-attempted') this.lastAttemptAt = at;
    if (this.remaining() === 0) this.endedAt = at;
  }

  view(now: Date = new Date()): ApplyProgress {
    return {
      total: this.total,
      done: this.done,
      failed: this.failed,
      notAttempted: this.notAttempted,
      remaining: this.remaining(),
      rate: this.rate,
      startedAt: this.startedAt.toISOString(),
      estimatedEndAt: this.estimatedEnd(now)?.toISOString() ?? null,
      stoppedBy: this.stoppedBy,
      phase: this.phase,
    };
  }

  private remaining(): number {
    return this.total - this.done - this.failed - this.notAttempted;
  }

  /** The steps left at the average time per attempted step so far, from the last one; never before `now`. */
  private estimatedEnd(now: Date): Date | null {
    if (this.endedAt) return this.endedAt;
    const attempted = this.done + this.failed;
    if (attempted === 0 || !this.lastAttemptAt) return null;
    const perStep = (this.lastAttemptAt.getTime() - this.startedAt.getTime()) / attempted;
    return new Date(Math.max(now.getTime(), this.lastAttemptAt.getTime() + perStep * this.remaining()));
  }
}
