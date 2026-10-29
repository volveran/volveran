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
// With any Replay or Move, the confirmation has a Replay Rate field,
// prefilled with the Broker Profile's default, and shows how long those
// steps take at the rate. Empty runs unthrottled, unless the profile sets a
// maximum; the server checks the rate too.
//
// With any Replay (and no Approval needed), the Apply can start with a
// Canary: the first Replay by default, or a Message picked from the
// Replays. The confirmation shows the Watch Window and says beforehand when
// that Canary cannot be watched.
//
// The confirmation is a Prompt (keyboard.tsx): opening it focuses the typed
// queue name, or else Cancel, so no key press confirms it; Escape closes it
// and gives the focus back to "Apply…". The Checkout view says whether it is
// open, so its shortcuts pause meanwhile.
import { useState } from 'react';
import type { CanaryChoice, CanaryConfirmation, DecisionSummaryLine } from './api.js';
import { decisionLabel } from '../shared/decisions.js';
import type { CheckoutQueueType } from '../shared/checkout.js';
import { MAX_REPLAY_RATE, MIN_REPLAY_RATE, pacedDurationMs } from '../shared/replay-rate.js';
import { returnOrder } from '../shared/return-order.js';
import { formatCountdown } from './countdown.js';
import { Prompt } from './keyboard.js';

interface ConfirmationProps {
  profile: string;
  protectedProfile: boolean;
  queue: string;
  queueType: CheckoutQueueType;
  typeQueueName: boolean;
  approvalRequired: boolean;
  /** The Broker Profile's default Replay Rate (prefilled) and maximum; null when not set. */
  replayRate: { default: number | null; max: number | null };
  summary: DecisionSummaryLine[];
  summaryText: string;
  /** The Messages that may be the Canary, and the Watch Window. */
  canary: CanaryConfirmation;
  /** The message id shown for a Message handle, for the Canary pick. */
  messageLabel(handle: number): string;
  busy: boolean;
  /** `rate`: the Replay Rate chosen; left out when the field is empty (unthrottled). `canary`: left out for none. */
  onApply: (confirmQueueName?: string, rate?: number, canary?: CanaryChoice) => void;
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
  replayRate,
  summary,
  summaryText,
  canary,
  messageLabel,
  busy,
  onApply,
  onClose,
}: ConfirmationProps & { onClose(): void }) {
  const [typed, setTyped] = useState('');
  const [withCanary, setWithCanary] = useState(false);
  const [canaryPick, setCanaryPick] = useState<number | null>(null);
  // Approval with a Canary comes later; for now only an Apply without Approval offers one.
  const offerCanary = !approvalRequired && canary.candidates.length > 0;
  const pickedCandidate = canary.candidates.find((c) => c.handle === canaryPick) ?? canary.candidates[0];
  const [rateInput, setRateInput] = useState(replayRate.default === null ? '' : String(replayRate.default));
  const count = (kind: DecisionSummaryLine['kind']) =>
    summary.filter((l) => l.kind === kind).reduce((n, l) => n + l.count, 0);
  const typedOk = !typeQueueName || typed === queue;
  const paced = count('replay') + count('move');
  // A profile with a maximum needs a rate for any Apply (unthrottled is above it).
  const askRate = paced > 0 || replayRate.max !== null;
  const rate = rateInput.trim() === '' ? null : Number(rateInput);
  const highest = replayRate.max ?? MAX_REPLAY_RATE;
  const rateProblem =
    !askRate
      ? null
      : rate === null
        ? replayRate.max === null
          ? null
          : `${profile} allows at most ${replayRate.max} Messages/s: give a rate.`
        : !Number.isFinite(rate) || rate < MIN_REPLAY_RATE || rate > highest
          ? `The rate must be a number of Messages per second from ${MIN_REPLAY_RATE} to ${highest}.`
          : null;
  const estimate = pacedDurationMs(paced, rate);

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
        {askRate && (
          <label className="replay-rate">
            <span>Replay Rate (Messages per second; empty for as fast as the broker confirms)</span>
            <input
              type="number"
              min={MIN_REPLAY_RATE}
              max={highest}
              step="any"
              value={rateInput}
              onChange={(e) => setRateInput(e.target.value)}
              aria-label="Replay Rate"
              aria-invalid={rateProblem !== null}
            />
            <small className={rateProblem ? 'rate-problem' : 'muted'}>
              {rateProblem ??
                (estimate === null
                  ? `${paced} Replay and Move steps, unthrottled.`
                  : `${paced} Replay and Move steps take about ${formatCountdown(estimate)} at ${rate} Messages/s; Discards are not slowed down.`)}
            </small>
          </label>
        )}
        {offerCanary && (
          <div className="canary-choice">
            <label>
              <input type="checkbox" checked={withCanary} onChange={(e) => setWithCanary(e.target.checked)} /> Start with a
              Canary: Replay one Message alone, watch for {formatCountdown(canary.watchWindowMs)} whether it is
              dead-lettered here again, then continue or stop
            </label>
            {withCanary && (
              <>
                <label>
                  <span>Canary</span>{' '}
                  <select
                    aria-label="Canary"
                    value={pickedCandidate?.handle ?? ''}
                    onChange={(e) => setCanaryPick(Number(e.target.value))}
                  >
                    {canary.candidates.map((c, i) => (
                      <option key={c.handle} value={c.handle}>
                        {messageLabel(c.handle)}
                        {i === 0 ? ' (first Replay)' : ''}
                      </option>
                    ))}
                  </select>
                </label>
                {pickedCandidate && !pickedCandidate.watch.watchable && (
                  <small className="rate-problem">Unwatched: {pickedCandidate.watch.reason}</small>
                )}
              </>
            )}
          </div>
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
            disabled={busy || !typedOk || rateProblem !== null}
            onClick={() => {
              const confirmQueueName = typeQueueName ? typed : undefined;
              onClose();
              const choice: CanaryChoice | undefined =
                offerCanary && withCanary
                  ? canaryPick === null || pickedCandidate?.handle === canary.candidates[0]?.handle
                    ? true
                    : { handle: canaryPick }
                  : undefined;
              onApply(confirmQueueName, askRate && rate !== null ? rate : undefined, choice);
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
