// The progress of an Apply running in the background: a bar of the steps
// done, failed and still to go, the Replay Rate it runs at, and when it
// should end at its pace so far.
// The Checkout view polls the Checkout while it shows this.
import type { ApplyProgress } from './api.js';
import { rateText } from '../shared/replay-rate.js';
import { formatCountdown } from './countdown.js';

export function ApplyProgressPanel({ progress, now }: { progress: ApplyProgress; now: number }) {
  const share = (n: number) => `${progress.total === 0 ? 0 : (n / progress.total) * 100}%`;
  const endsAt = progress.estimatedEndAt === null ? null : Date.parse(progress.estimatedEndAt);
  return (
    <div className="apply-progress" role="status">
      <strong>Applying</strong> <small className="muted">at {rateText(progress.rate)}</small>
      <div
        className="progress-bar"
        role="progressbar"
        aria-label="Apply progress"
        aria-valuemin={0}
        aria-valuemax={progress.total}
        aria-valuenow={progress.total - progress.remaining}
      >
        <span className="progress-done" style={{ width: share(progress.done) }} />
        <span className="progress-failed" style={{ width: share(progress.failed + progress.notAttempted) }} />
      </div>
      <p>
        {progress.done} of {progress.total} done, {progress.failed} failed
        {progress.notAttempted > 0 && `, ${progress.notAttempted} not attempted`}, {progress.remaining} to go
        {endsAt !== null && progress.remaining > 0 && ` · about ${formatCountdown(endsAt - now)} left`}.
      </p>
      <p>
        The Apply runs on the server: closing this page does not stop it. The outcome for each Message shows here once
        it ends.
      </p>
    </div>
  );
}
