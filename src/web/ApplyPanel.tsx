// The summary of the staged Decisions and the single confirmation that
// covers the whole Apply. The confirmation names the Broker Profile and
// counts the Messages per Decision; on a Protected Profile, when the
// Checkout's applyConfirmation asks for it (any Decision other than Keep),
// Confirm Apply stays disabled until the Operator types the queue name.
// The server checks the typed name too (routes/apply.ts).
//
// When the Apply needs Approval (Team Mode, a Protected Profile), the same
// confirmation requests Approval instead: the Checkout then waits for a
// second Operator (routes/approvals.ts).
//
// The confirmation is a Prompt (keyboard.tsx): opening it focuses the typed
// queue name, or else Cancel, so no key press confirms it; Escape closes it
// and gives the focus back to "Apply…". The Checkout view says whether it is
// open, so its shortcuts pause meanwhile.
import { useState } from 'react';
import type { DecisionSummaryLine } from './api.js';
import { decisionLabel } from '../shared/decisions.js';
import type { CheckoutQueueType } from '../shared/checkout.js';
import { returnOrder } from '../shared/return-order.js';
import { Prompt } from './keyboard.js';

interface ConfirmationProps {
  profile: string;
  protectedProfile: boolean;
  queue: string;
  queueType: CheckoutQueueType;
  typeQueueName: boolean;
  approvalRequired: boolean;
  summary: DecisionSummaryLine[];
  summaryText: string;
  busy: boolean;
  onApply: (confirmQueueName?: string) => void;
}

export function ApplyPanel({
  confirming,
  onConfirming,
  ...props
}: ConfirmationProps & { confirming: boolean; onConfirming: (open: boolean) => void }) {
  const actions = props.summary.filter((l) => l.kind !== 'keep').length;
  return (
    <div className="apply-panel">
      <button disabled={props.busy || actions === 0} onClick={() => onConfirming(true)}>
        {props.approvalRequired ? 'Request Approval…' : 'Apply…'}
      </button>
      {confirming && <ApplyConfirmation {...props} onClose={() => onConfirming(false)} />}
    </div>
  );
}

function ApplyConfirmation({
  profile,
  protectedProfile,
  queue,
  queueType,
  typeQueueName,
  approvalRequired,
  summary,
  summaryText,
  busy,
  onApply,
  onClose,
}: ConfirmationProps & { onClose(): void }) {
  const [typed, setTyped] = useState('');
  const count = (kind: DecisionSummaryLine['kind']) =>
    summary.filter((l) => l.kind === kind).reduce((n, l) => n + l.count, 0);
  const typedOk = !typeQueueName || typed === queue;

  return (
    <Prompt label={approvalRequired ? 'Request Approval' : 'Confirm Apply'} onClose={onClose}>
      <div className="confirm">
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
          {count('move') > 0 &&
            'Moved Messages are sent to the destination you chose, without their dead-letter headers. '}
          Every other Message goes back to the queue {returnOrder(queueType)}, and the Checkout ends.
        </span>
        {approvalRequired && (
          <span className="approval-note">
            {profile} requires Approval: this Apply runs only once another Operator with the role{' '}
            <code>operator</code> or <code>admin</code> on it approves. Until then your Decisions cannot change; you
            can withdraw the request.
          </span>
        )}
        {typeQueueName && (
          <label className="type-queue-name">
            <span>
              {profile} is a Protected Profile: type <code>{queue}</code> to confirm
            </span>
            <input
              data-autofocus
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
              onClose();
              onApply(confirmQueueName);
            }}
          >
            {approvalRequired ? 'Request Approval' : 'Confirm Apply'}
          </button>{' '}
          <button className="link" data-autofocus={typeQueueName ? undefined : true} onClick={onClose}>
            Cancel
          </button>
        </span>
      </div>
    </Prompt>
  );
}
