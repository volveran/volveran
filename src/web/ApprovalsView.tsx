// Approvals (Team Mode): other Operators' Checkouts waiting for an Approval
// this Operator may give (role `operator` or `admin` on the profile), and a
// read-only view of one of them: its Decisions, Messages and Message view,
// as the requester sees them. Approve asks for the queue name typed, then
// runs the Apply on the requester's Checkout and shows its outcome. No key
// approves (keyboard-commands.ts): Approve always needs its confirmation.
import { useEffect, useState } from 'react';
import { heldLine } from '../shared/held-line.js';
import { decisionLabel } from '../shared/decisions.js';
import { api, ApiError, type ApprovalSummary, type Checkout, type MessageDetail, type MessageOutcome } from './api.js';
import { ApplyOutcomes } from './ApplyOutcomes.js';
import { MessageDetailView, MessageList } from './MessageList.js';
import { SignInAgain } from './SignInAgain.js';

/** How often the list and an open waiting Checkout are read again. */
const REFRESH_MS = 5_000;

export function ApprovalsView() {
  const [approvals, setApprovals] = useState<ApprovalSummary[]>();
  const [error, setError] = useState<ApiError>();
  const [open, setOpen] = useState<string | null>(null);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    if (open) return;
    let cancelled = false;
    const load = () =>
      api
        .approvals()
        .then((list) => {
          if (cancelled) return;
          setApprovals(list);
          setError(undefined);
        })
        .catch((err) => !cancelled && setError(err));
    void load();
    const timer = setInterval(load, REFRESH_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [open, tick]);

  if (open) {
    return (
      <WaitingCheckout
        id={open}
        onClose={() => {
          setOpen(null);
          setTick((n) => n + 1);
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
              <th>Requested</th>
              <th>Decisions</th>
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
                <td>{new Date(a.requestedAt).toLocaleTimeString()}</td>
                <td>{a.decisionSummaryText}</td>
                <td>
                  <button onClick={() => setOpen(a.checkoutId)}>Review</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}

/** One waiting Checkout, read-only, with Approve. */
function WaitingCheckout({ id, onClose }: { id: string; onClose(): void }) {
  const [checkout, setCheckout] = useState<Checkout>();
  const [error, setError] = useState<ApiError>();
  const [focused, setFocused] = useState<number>();
  const [detail, setDetail] = useState<MessageDetail>();
  const [confirming, setConfirming] = useState(false);
  const [typed, setTyped] = useState('');
  const [busy, setBusy] = useState(false);
  /** The Apply this Operator approved, once it has run. */
  const [result, setResult] = useState<{ checkout: Checkout; outcomes: MessageOutcome[] }>();

  useEffect(() => {
    if (result) return;
    let cancelled = false;
    const load = () =>
      api
        .approvalCheckout(id)
        .then((c) => !cancelled && setCheckout(c))
        .catch((err) => !cancelled && setError(err));
    void load();
    const timer = setInterval(load, REFRESH_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [id, result]);

  useEffect(() => {
    if (focused === undefined || result) return setDetail(undefined);
    let cancelled = false;
    api
      .approvalMessage(id, focused)
      .then((m) => !cancelled && setDetail(m))
      .catch((err) => !cancelled && setError(err));
    return () => {
      cancelled = true;
    };
  }, [id, focused, result]);

  const approve = async () => {
    setBusy(true);
    try {
      setResult(await api.approve(id, typed));
      setError(undefined);
    } catch (err) {
      setError(err as ApiError);
    } finally {
      setBusy(false);
      setConfirming(false);
      setTyped('');
    }
  };

  const back = <button onClick={onClose}>Back to Approvals</button>;
  if (result) {
    return (
      <section className="checkout">
        <div className="checkout-head">
          <h2>Approved: Apply of {result.checkout.queue}</h2>
          {back}
        </div>
        <ApplyOutcomes outcomes={result.outcomes} approvedBy={result.checkout.lastApply?.approvedBy ?? null} />
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
          <p className="held">{heldLine(checkout)}</p>
        </div>
        {back}
      </div>
      {error && <ErrorBox error={error} />}

      <p className="decision-summary">
        <strong>Decisions:</strong> {checkout.decisionSummaryText}
      </p>
      <div className="apply-panel">
        {!confirming ? (
          <button disabled={busy} onClick={() => setConfirming(true)}>
            Approve…
          </button>
        ) : (
          <div className="confirm" role="alertdialog" aria-label="Approve Apply">
            <strong className="confirm-profile protected">
              <span className="badge protected-badge">Protected Profile</span> Approve the Apply of {checkout.operator}{' '}
              on {checkout.profile} · {checkout.queue}
            </strong>
            <ul className="confirm-counts">
              {checkout.decisionSummary.map((l) => (
                <li key={decisionLabel(l)}>
                  <strong>{l.count}</strong> {decisionLabel(l)}
                </li>
              ))}
            </ul>
            <span>Approving runs the Apply now, on {checkout.operator}'s Checkout; its Audit Entries name you as the approver.</span>
            <label className="type-queue-name">
              <span>
                Type <code>{checkout.queue}</code> to confirm
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
            <span>
              <button className="danger" disabled={busy || typed !== checkout.queue} onClick={() => void approve()}>
                Approve and Apply
              </button>{' '}
              <button
                className="link"
                onClick={() => {
                  setConfirming(false);
                  setTyped('');
                }}
              >
                Cancel
              </button>
            </span>
          </div>
        )}
      </div>

      <div className="checkout-body">
        <MessageList
          messages={checkout.messages}
          empty="The Checkout holds no Messages."
          quorum={checkout.queueType === 'quorum' && checkout.deliveryLimit !== null}
          focused={focused}
          onFocus={setFocused}
        />
        {detail && <MessageDetailView message={detail} />}
      </div>
    </section>
  );
}

function ErrorBox({ error }: { error: ApiError }) {
  return (
    <div className="error" role="alert">
      <p>{error.message}</p>
      <code>{error.code}</code>
      <SignInAgain error={error} />
    </div>
  );
}
