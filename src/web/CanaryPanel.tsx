// The Canary of an Apply: while it is watched, the time left in the Watch
// Window; then its outcome (died again with the new reason, not
// dead-lettered here, unwatched or failed, with why). While the Apply waits
// after it, Continue carries out the rest and Stop returns the rest to the
// queue as Keep. Continuing before the Watch Window ends is allowed.
// Once the Apply has moved on, the outcome stays as a record.
import { useState } from 'react';
import type { ApplyProgress, CanaryView, RequestedCanary } from './api.js';
import { formatCountdown } from './countdown.js';

/** How a request for Approval names its Canary. */
export function requestedCanaryText(canary: RequestedCanary): string {
  return `starts with a Canary: ${canary.messageId ?? `Message ${canary.handle}`}`;
}

const OUTCOME: Record<CanaryView['status'], string> = {
  watching: 'Watching',
  died_again: 'Died again',
  not_dead_lettered: 'Not dead-lettered here',
  unwatched: 'Unwatched',
  failed: 'Replay failed',
};

/** `onContinue` / `onStop`: without them (someone who may not decide) there are no buttons. */
export function CanaryPanel({
  canary,
  progress,
  now,
  onContinue,
  onStop,
}: {
  canary: CanaryView;
  progress: ApplyProgress | null;
  now: number;
  onContinue?(): Promise<void>;
  onStop?(): Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const run = (action?: () => Promise<void>) => async () => {
    setBusy(true);
    try {
      await action?.();
    } finally {
      setBusy(false);
    }
  };
  const waiting = progress !== null && progress.phase !== 'running' && progress.stoppedBy === null;
  const endsAt = canary.watchEndsAt === null ? null : Date.parse(canary.watchEndsAt);
  const label = canary.messageId ?? `Message ${canary.handle}`;
  return (
    <div className={`canary-panel canary-${canary.status}`} role="status">
      <strong>Canary {label}</strong>{' '}
      <span className="badge">{OUTCOME[canary.status]}</span>
      {canary.status === 'watching' && endsAt !== null && (
        <p>
          Replayed alone; watching the dead-letter exchange for <strong>{formatCountdown(Math.max(0, endsAt - now))}</strong>{' '}
          more. Every other Message is still held.
        </p>
      )}
      {canary.status === 'died_again' && (
        <p>
          It was dead-lettered again
          {canary.deadLetterReason && (
            <>
              : <code>{canary.deadLetterReason}</code>
            </>
          )}
          {canary.failureDetails?.message && <> ({canary.failureDetails.message})</>}.
        </p>
      )}
      {canary.status === 'not_dead_lettered' && (
        <p>
          Not dead-lettered here within the Watch Window
          {endsAt !== null && ` (watched until ${new Date(endsAt).toLocaleTimeString()})`}. A consumer that parks failures
          elsewhere would not show here.
        </p>
      )}
      {(canary.status === 'unwatched' || canary.status === 'failed') && canary.watchProblem && <p>{canary.watchProblem}</p>}
      {waiting && (onContinue || onStop) && (
        <p>
          {onContinue && (
            <button disabled={busy} onClick={run(onContinue)}>
              Continue with the rest
            </button>
          )}{' '}
          {onStop && (
            <button className="danger" disabled={busy} onClick={run(onStop)}>
              Stop: the rest goes back as Keep
            </button>
          )}
        </p>
      )}
    </div>
  );
}
