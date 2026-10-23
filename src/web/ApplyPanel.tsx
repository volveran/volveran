// The summary of the staged Decisions and the single confirmation that
// covers the whole Apply. (#9 adds typing the queue name on a Protected
// Profile, from the Checkout's applyConfirmation.)
import { useState } from 'react';
import type { DecisionSummaryLine } from './api.js';

export function ApplyPanel({
  summary,
  summaryText,
  busy,
  onApply,
}: {
  summary: DecisionSummaryLine[];
  summaryText: string;
  busy: boolean;
  onApply: () => void;
}) {
  const [confirming, setConfirming] = useState(false);
  const count = (kind: DecisionSummaryLine['kind']) =>
    summary.filter((l) => l.kind === kind).reduce((n, l) => n + l.count, 0);
  const actions = summary.filter((l) => l.kind !== 'keep').length;
  const notYet = count('replay') + count('move');

  return (
    <div className="apply-panel">
      {!confirming ? (
        <button disabled={busy || actions === 0} onClick={() => setConfirming(true)}>
          Apply…
        </button>
      ) : (
        <span className="confirm" role="alertdialog" aria-label="Confirm Apply">
          <span>
            Apply {summaryText}?
            {count('discard') > 0 &&
              ' Discarded Messages are removed from the queue; a full copy of each is kept in its Audit Entry.'}
            {notYet > 0 && ' Replay and Move are not available yet: those Messages go back to the queue.'}
            {' '}Every Message not Discarded goes back to the queue in its original order, and the Checkout ends.
          </span>
          <button
            className="danger"
            disabled={busy}
            onClick={() => {
              setConfirming(false);
              onApply();
            }}
          >
            Confirm Apply
          </button>
          <button className="link" onClick={() => setConfirming(false)}>
            Cancel
          </button>
        </span>
      )}
    </div>
  );
}
