// The progress of an Apply running in the background: a bar of the steps
// done, failed and still to go, the Replay Rate it runs at, and when it
// should end at its pace so far.
// The Checkout view polls the Checkout while it shows this, and so does the
// approver's view of an Apply they approved. Both may stop the Apply: Stop
// asks for a confirmation (a Prompt that focuses Cancel and closes on
// Escape), then the step in progress finishes and the rest goes back to the
// queue as Keep.
import { useState } from 'react';
import type { ApplyProgress } from './api.js';
import { rateText } from '../shared/replay-rate.js';
import { formatCountdown } from './countdown.js';
import { Prompt } from './keyboard.js';

/** `onStop`: stops the Apply; without it there is no Stop button. */
export function ApplyProgressPanel({
  progress,
  now,
  onStop,
}: {
  progress: ApplyProgress;
  now: number;
  onStop?(): Promise<void>;
}) {
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const stop = async () => {
    setConfirming(false);
    setBusy(true);
    try {
      await onStop?.();
    } finally {
      setBusy(false);
    }
  };
  const share = (n: number) => `${progress.total === 0 ? 0 : (n / progress.total) * 100}%`;
  const endsAt = progress.estimatedEndAt === null ? null : Date.parse(progress.estimatedEndAt);
  return (
    <div className="apply-progress" role="status">
      <strong>{progress.stoppedBy === null ? 'Applying' : 'Stopping'}</strong>{' '}
      <small className="muted">at {rateText(progress.rate)}</small>
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
      {progress.stoppedBy !== null ? (
        <p>
          Stopped by {progress.stoppedBy}: the step in progress finishes, and the rest goes back to the queue as Keep.
        </p>
      ) : (
        <p>
          The Apply runs on the server: closing this page does not stop it. The outcome for each Message shows here
          once it ends.
        </p>
      )}
      {onStop && progress.stoppedBy === null && progress.remaining > 0 && (
        <button className="danger" disabled={busy} onClick={() => setConfirming(true)}>
          Stop…
        </button>
      )}
      {confirming && (
        <Prompt label="Stop the Apply" onClose={() => setConfirming(false)}>
          <div className="confirm">
            <strong>Stop the Apply?</strong>
            <span>
              The step in progress finishes, and no further step is attempted. Every Message left is reported not
              attempted and goes back to the queue in its original order, as Keep.
            </span>
            <span>
              <button className="danger" onClick={() => void stop()}>
                Stop the Apply
              </button>{' '}
              <button className="link" data-autofocus onClick={() => setConfirming(false)}>
                Cancel
              </button>
            </span>
          </div>
        </Prompt>
      )}
    </div>
  );
}
