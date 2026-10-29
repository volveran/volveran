// Approvals (Team Mode): other Operators' Checkouts waiting for an Approval
// this Operator may give (role `operator` or `admin` on the profile), and a
// read-only view of one of them: its Decisions, Messages and Message view,
// as the requester sees them, and two ticked Messages side by side. Approve
// asks for the queue name typed, then starts the Apply on the requester's
// Checkout (the requester sees its progress and outcome there; so does the
// approver, who may stop it, and continue or stop it after its Canary); Reject
// asks for a reason, which the requester sees. No key approves or rejects
// (keyboard-commands.ts): both always need their confirmation, a Prompt
// (keyboard.tsx) that focuses its typed field, closes on Escape and gives
// the focus back to "Approve…" or "Reject…". A requester's
// link (approval-link.ts) opens here on their waiting Checkout.
import { useEffect, useState, type ReactNode } from 'react';
import { heldLine } from '../shared/held-line.js';
import { decisionLabel } from '../shared/decisions.js';
import { rateText } from '../shared/replay-rate.js';
import { formatCountdown } from './countdown.js';
import { api, ApiError, type ApprovalSummary, type Checkout, type MessageDetail } from './api.js';
import { ComparisonView } from './ComparisonView.js';
import { MessageDetailView, MessageList } from './MessageList.js';
import { ApplyOutcomes } from './ApplyOutcomes.js';
import { ApplyProgressPanel } from './ApplyProgress.js';
import { CanaryPanel, requestedCanaryText } from './CanaryPanel.js';
import { ErrorBox } from './ErrorBox.js';
import { useNow, usePolling } from './timers.js';
import { Prompt } from './keyboard.js';

/** How often the list and an open waiting Checkout are read again. */
const REFRESH_MS = 5_000;
/** How often the Checkout of an Apply this Operator approved is read while it runs. */
const APPLY_POLL_MS = 1_000;

/** `initialOpen`: the waiting Checkout a requester's link points at, opened first. `onClosed` runs when it is left. */
export function ApprovalsView({ initialOpen = null, onClosed }: { initialOpen?: string | null; onClosed?(): void }) {
  const [approvals, setApprovals] = useState<ApprovalSummary[]>();
  const [error, setError] = useState<ApiError>();
  const [open, setOpen] = useState<string | null>(initialOpen);
  const [tick, setTick] = useState(0);
  /** Date.now() when `approvals` arrived: waiting and time left count on from there. */
  const [receivedAt, setReceivedAt] = useState(0);
  const now = useNow(open === null);

  usePolling(
    {
      load: api.approvals,
      received: (list) => {
        setApprovals(list);
        setReceivedAt(Date.now());
        setError(undefined);
      },
      failed: setError,
      everyMs: REFRESH_MS,
      enabled: open === null,
    },
    [open, tick],
  );

  if (open) {
    return (
      <WaitingCheckout
        id={open}
        onClose={() => {
          setOpen(null);
          setTick((n) => n + 1);
          onClosed?.();
        }}
      />
    );
  }

  return (
    <section className="approvals">
      <h2>Waiting for your Approval</h2>
      {error && <ErrorBox error={error} />}
      {approvals && approvals.length === 0 && (
        <p className="empty">No Apply is waiting for an Approval you can give.</p>
      )}
      {approvals && approvals.length > 0 && (
        <table className="queues">
          <thead>
            <tr>
              <th>Requester</th>
              <th>Broker Profile</th>
              <th>Vhost</th>
              <th>Queue</th>
              <th>Waiting</th>
              <th>Time left</th>
              <th>Decisions</th>
              <th>Replay Rate</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {approvals.map((a) => (
              <tr key={a.checkoutId}>
                <td>{a.requester}</td>
                <td>{a.profile}</td>
                <td>{a.vhost}</td>
                <td className="name">{a.queue}</td>
                <td title={`Requested at ${new Date(a.requestedAt).toLocaleTimeString()}`}>
                  {formatCountdown(a.waitingMs + (now - receivedAt))}
                </td>
                <td title={`The Checkout, and the request, end at ${new Date(a.endsAt).toLocaleTimeString()}`}>
                  {formatCountdown(a.remainingMs - (now - receivedAt))}
                </td>
                <td>
                  <ul className="decision-counts">
                    {a.decisionSummary.map((l) => (
                      <li key={decisionLabel(l)}>
                        <strong>{l.count}</strong> {decisionLabel(l)}
                      </li>
                    ))}
                  </ul>
                </td>
                <td>
                  {rateText(a.rate)}
                  {a.canary && <div className="muted">{requestedCanaryText(a.canary)}</div>}
                </td>
                <td>
                  <button onClick={() => setOpen(a.checkoutId)}>Open</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}

/** The Apply this Operator approved: its progress, with Stop, until it ends, then the outcome for each Message. */
function ApprovedApply({ approved, back }: { approved: Checkout; back: ReactNode }) {
  const [checkout, setCheckout] = useState(approved);
  const [error, setError] = useState<ApiError>();
  const now = useNow();
  const applying = checkout.status === 'applying' || (checkout.applyProgress !== null && checkout.lastApply === null);
  usePolling(
    {
      load: () => api.approvalCheckout(approved.id),
      received: (c) => {
        setCheckout(c);
        setError(undefined);
      },
      failed: setError,
      everyMs: APPLY_POLL_MS,
      enabled: applying,
    },
    [approved.id, applying],
  );
  const act = (action: (id: string) => Promise<Checkout>) => async () => {
    try {
      setCheckout(await action(approved.id));
      setError(undefined);
    } catch (err) {
      setError(err as ApiError);
    }
  };
  const stop = act(api.stopApprovedApply);

  return (
    <section className="checkout">
      <div className="checkout-head">
        <h2>Approved: Apply of {checkout.queue}</h2>
        {back}
      </div>
      <p>
        The Apply runs on {checkout.operator}'s Checkout ({approved.decisionSummaryText}); {checkout.operator} sees it
        there too. Its Audit Entries name you as the approver.
      </p>
      {error && <ErrorBox error={error} />}
      {checkout.canary && (
        <CanaryPanel
          canary={checkout.canary}
          progress={applying ? checkout.applyProgress : null}
          now={now}
          onContinue={act(api.continueApprovedApply)}
          onStop={stop}
        />
      )}
      {applying && checkout.applyProgress && (
        <ApplyProgressPanel progress={checkout.applyProgress} now={now} onStop={stop} />
      )}
      {checkout.lastApply && <ApplyOutcomes outcomes={checkout.lastApply.outcomes} approvedBy={checkout.lastApply.approvedBy} />}
    </section>
  );
}

/** One waiting Checkout, read-only, with Approve and Reject. */
function WaitingCheckout({ id, onClose }: { id: string; onClose(): void }) {
  const [checkout, setCheckout] = useState<Checkout>();
  const [error, setError] = useState<ApiError>();
  const [focused, setFocused] = useState<number>();
  const [detail, setDetail] = useState<MessageDetail>();
  /** Ticked Messages: two of them can be compared. */
  const [ticked, setTicked] = useState<ReadonlySet<number>>(new Set());
  const [comparing, setComparing] = useState<readonly [number, number] | null>(null);
  /** The open confirmation: Approve (queue name typed) or Reject (a reason). */
  const [confirming, setConfirming] = useState<'approve' | 'reject' | null>(null);
  const [typed, setTyped] = useState('');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  /** The Checkout whose Apply this Operator approved, as the Apply started. */
  const [result, setResult] = useState<Checkout>();
  /** The request this Operator rejected: the Checkout is back with its requester. */
  const [rejected, setRejected] = useState<Checkout>();
  const done = result !== undefined || rejected !== undefined;

  usePolling(
    {
      load: () => api.approvalCheckout(id),
      received: (c) => {
        setCheckout(c);
        setError(undefined);
      },
      failed: (err) => {
        setError(err);
        // No longer waiting (withdrawn, approved, rejected, over): the error says why; nothing to show.
        if (err instanceof ApiError && err.code === 'not_awaiting_approval') setCheckout(undefined);
      },
      everyMs: REFRESH_MS,
      enabled: !done,
    },
    [id, done],
  );

  useEffect(() => {
    if (focused === undefined || done) return setDetail(undefined);
    let cancelled = false;
    api
      .approvalMessage(id, focused)
      .then((m) => !cancelled && setDetail(m))
      .catch((err) => !cancelled && setError(err));
    return () => {
      cancelled = true;
    };
  }, [id, focused, done]);

  const approve = async () => {
    setBusy(true);
    try {
      setResult(await api.approve(id, typed));
      setError(undefined);
    } catch (err) {
      setError(err as ApiError);
    } finally {
      setBusy(false);
      setConfirming(null);
      setTyped('');
    }
  };

  const reject = async () => {
    setBusy(true);
    try {
      setRejected(await api.reject(id, reason));
      setError(undefined);
    } catch (err) {
      setError(err as ApiError);
    } finally {
      setBusy(false);
      setConfirming(null);
      setReason('');
    }
  };

  const closeConfirmation = () => {
    setConfirming(null);
    setTyped('');
    setReason('');
  };

  const back = <button onClick={onClose}>Back to Approvals</button>;
  if (result) return <ApprovedApply approved={result} back={back} />;
  // Reopened after approving (e.g. to continue after the Canary): the server shows this approver its Apply.
  if (checkout && checkout.approvalRequest === null && checkout.applyProgress !== null) {
    return <ApprovedApply approved={checkout} back={back} />;
  }
  if (rejected) {
    return (
      <section className="checkout">
        <div className="checkout-head">
          <h2>Rejected: Apply of {rejected.queue}</h2>
          {back}
        </div>
        <p className="empty">
          The Checkout is back with {rejected.operator}, who sees your reason: “{rejected.rejection?.reason}”.
        </p>
      </section>
    );
  }
  if (!checkout) {
    return (
      <section className="checkout">
        {error ? <ErrorBox error={error} /> : <p className="empty">Loading the Checkout…</p>}
        {back}
      </section>
    );
  }

  return (
    <section className="checkout protected">
      <div className="checkout-head">
        <div>
          <p className="protected-banner" role="note">
            <span className="badge protected-badge">Protected Profile</span> {checkout.profile}: this Apply waits for
            your Approval. Read-only: only {checkout.operator} can change the Decisions.
          </p>
          <h2>
            Checkout of {checkout.queue} <span className={`badge type-${checkout.queueType}`}>{checkout.queueType}</span>
          </h2>
          <p className="who">
            {checkout.profile} · vhost {checkout.vhost} · started by {checkout.operator}
            {checkout.approvalRequest &&
              ` · Approval requested at ${new Date(checkout.approvalRequest.requestedAt).toLocaleTimeString()}`}
          </p>
          <p className="replay-rate-line">
            {checkout.approvalRequest && (
              <>
                Runs <strong>{rateText(checkout.approvalRequest.rate)}</strong>
                {checkout.applyConfirmation.estimatedDurationMs !== null &&
                  `: its Replay and Move steps take about ${formatCountdown(checkout.applyConfirmation.estimatedDurationMs)}`}
                {checkout.approvalRequest.canary && (
                  <>
                    {' '}
                    · <strong>{requestedCanaryText(checkout.approvalRequest.canary)}</strong>, watched for{' '}
                    {formatCountdown(checkout.applyConfirmation.canary.watchWindowMs)}; then you or {checkout.operator}{' '}
                    continue or stop
                  </>
                )}
              </>
            )}
          </p>
          <p className="held">{heldLine(checkout)}</p>
        </div>
        {back}
      </div>
      {error && <ErrorBox error={error} />}

      <p className="decision-summary">
        <strong>Decisions:</strong> {checkout.decisionSummaryText}
      </p>
      <div className="apply-panel">
        <span>
          <button disabled={busy} onClick={() => setConfirming('approve')}>
            Approve…
          </button>{' '}
          <button disabled={busy} onClick={() => setConfirming('reject')}>
            Reject…
          </button>
        </span>
        {confirming === 'reject' && (
          <Prompt label="Reject Apply" onClose={closeConfirmation}>
            <div className="confirm">
              <strong>
                Reject the Apply of {checkout.operator} on {checkout.profile} · {checkout.queue}
              </strong>
              <span>The Checkout goes back to {checkout.operator}, who sees your reason and can change the Decisions.</span>
              <label className="reject-reason">
                <span>Reason (required)</span>
                <textarea data-autofocus value={reason} onChange={(e) => setReason(e.target.value)} rows={3} />
              </label>
              <span>
                <button className="danger" disabled={busy || reason.trim() === ''} onClick={() => void reject()}>
                  Reject
                </button>{' '}
                <button className="link" onClick={closeConfirmation}>
                  Cancel
                </button>
              </span>
            </div>
          </Prompt>
        )}
        {confirming === 'approve' && (
          <Prompt label="Approve Apply" onClose={closeConfirmation}>
            <div className="confirm">
              <strong className="confirm-profile protected">
                <span className="badge protected-badge">Protected Profile</span> Approve the Apply of{' '}
                {checkout.operator} on {checkout.profile} · {checkout.queue}
              </strong>
              <ul className="confirm-counts">
                {checkout.decisionSummary.map((l) => (
                  <li key={decisionLabel(l)}>
                    <strong>{l.count}</strong> {decisionLabel(l)}
                  </li>
                ))}
              </ul>
              <span>
                Approving runs the Apply now, on {checkout.operator}'s Checkout; its Audit Entries name you as the
                approver.
                {checkout.approvalRequest?.canary &&
                  ` It ${requestedCanaryText(checkout.approvalRequest.canary)}, Replayed alone and watched; then you or ${checkout.operator} continue with the rest or stop, with no second Approval.`}
              </span>
              <label className="type-queue-name">
                <span>
                  Type <code>{checkout.queue}</code> to confirm
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
              <span>
                <button className="danger" disabled={busy || typed !== checkout.queue} onClick={() => void approve()}>
                  Approve and Apply
                </button>{' '}
                <button className="link" onClick={closeConfirmation}>
                  Cancel
                </button>
              </span>
            </div>
          </Prompt>
        )}
      </div>

      {comparing ? (
        <ComparisonView
          source="approval"
          id={checkout.id}
          handles={comparing}
          rows={checkout.messages}
          onClose={() => setComparing(null)}
        />
      ) : (
        <>
          <p className="decision-bar">
            <strong>{ticked.size} ticked</strong>
            <button
              disabled={ticked.size !== 2}
              onClick={() => {
                const [a, b] = checkout.messages.filter((m) => ticked.has(m.handle)).map((m) => m.handle);
                if (a !== undefined && b !== undefined) setComparing([a, b]);
              }}
              title="Tick two Messages to see them side by side, with what differs highlighted"
            >
              Compare
            </button>
          </p>
          <div className="checkout-body">
            <MessageList
              messages={checkout.messages}
              empty="The Checkout holds no Messages."
              quorum={checkout.queueType === 'quorum' && checkout.deliveryLimit !== null}
              focused={focused}
              onFocus={setFocused}
              selection={ticked}
              onSelection={setTicked}
            />
            {detail && <MessageDetailView message={detail} />}
          </div>
        </>
      )}
    </section>
  );
}
