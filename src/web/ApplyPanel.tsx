// The summary of the staged Decisions and the single confirmation that
// covers the whole Apply. The confirmation names the Broker Profile and
// counts the Messages per Decision; on a Protected Profile, when the
// Checkout's applyConfirmation asks for it (any Decision other than Keep),
// Confirm Apply stays disabled until the Operator types the queue name.
// The server checks the typed name too (routes/apply.ts).
import { useState } from 'react';
import type { DecisionSummaryLine } from './api.js';
import { decisionLabel } from '../shared/decisions.js';

export function ApplyPanel({
  profile,
  protectedProfile,
  queue,
  typeQueueName,
  summary,
  summaryText,
  busy,
  onApply,
}: {
  profile: string;
  protectedProfile: boolean;
  queue: string;
  typeQueueName: boolean;
  summary: DecisionSummaryLine[];
  summaryText: string;
  busy: boolean;
  onApply: (confirmQueueName?: string) => void;
}) {
  const [confirming, setConfirming] = useState(false);
  const [typed, setTyped] = useState('');
  const close = () => {
    setConfirming(false);
    setTyped('');
  };
  const count = (kind: DecisionSummaryLine['kind']) =>
    summary.filter((l) => l.kind === kind).reduce((n, l) => n + l.count, 0);
  const actions = summary.filter((l) => l.kind !== 'keep').length;
  const notYet = count('move');
  const typedOk = !typeQueueName || typed === queue;

  return (
    <div className="apply-panel">
      {!confirming ? (
        <button disabled={busy || actions === 0} onClick={() => setConfirming(true)}>
          Apply…
        </button>
      ) : (
        <div className="confirm" role="alertdialog" aria-label="Confirm Apply">
          <strong className={protectedProfile ? 'confirm-profile protected' : 'confirm-profile'}>
            {protectedProfile && <span className="badge protected-badge">Protected Profile</span>} Apply on{' '}
            {profile} · {queue}
          </strong>
          <ul className="confirm-counts" aria-label={`Apply ${summaryText}`}>
            {summary.map((l) => (
              <li key={decisionLabel(l)}>
                <strong>{l.count}</strong> {decisionLabel(l)}
              </li>
            ))}
          </ul>
          <span>
            {count('discard') > 0 &&
              'Discarded Messages are removed from the queue; a full copy of each is kept in its Audit Entry. '}
            {count('replay') > 0 &&
              'Replayed Messages are sent to the queue that dead-lettered them, without their dead-letter headers; their Audit Entries keep the original headers. '}
            {notYet > 0 && 'Move is not available yet: those Messages go back to the queue. '}
            Every other Message goes back to the queue in its original order, and the Checkout ends.
          </span>
          {typeQueueName && (
            <label className="type-queue-name">
              <span>
                {profile} is a Protected Profile: type <code>{queue}</code> to confirm
              </span>
              <input
                autoFocus
                value={typed}
                onChange={(e) => setTyped(e.target.value)}
                aria-label="Queue name"
                spellCheck={false}
                autoComplete="off"
              />
            </label>
          )}
          <span>
            <button
              className="danger"
              disabled={busy || !typedOk}
              onClick={() => {
                const confirmQueueName = typeQueueName ? typed : undefined;
                close();
                onApply(confirmQueueName);
              }}
            >
              Confirm Apply
            </button>{' '}
            <button className="link" onClick={close}>
              Cancel
            </button>
          </span>
        </div>
      )}
    </div>
  );
}
