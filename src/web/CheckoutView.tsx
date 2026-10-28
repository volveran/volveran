// A Checkout: how many Messages it holds, the list of held Messages with
// their Decisions, the Selection (ticked by hand or "Select all matching" a
// filter) and the detail of the Message being looked at. Ending it returns every Message to the queue;
// leaving the page ends it too (a beacon), so nothing stays held by accident.
// While the page shows the Checkout it sends heartbeats (without them the
// server ends it), and it counts down to the Checkout's time limit. Apply
// carries out the Decisions and ends the Checkout; the page then shows what
// happened to each Message. The keyboard moves through the Messages (the
// Message view follows), builds the Selection and assigns Decisions; the
// keys are mapped to commands in keyboard-commands.ts.
//
// When the Apply needs Approval (Team Mode, a Protected Profile), the Apply
// confirmation requests it instead; the Checkout then waits, its Decisions
// frozen, until another Operator approves it (the heartbeat brings the
// outcome back here) or the Operator withdraws the request.
import { useEffect, useRef, useState } from 'react';
import { heldLine } from '../shared/held-line.js';
import { product } from '../shared/product.js';
import { returnOrder } from '../shared/return-order.js';
import {
  api,
  ApiError,
  type Checkout,
  type Decision,
  type FilterClause,
  type MessageDetail,
  type MoveDestinations,
} from './api.js';
import { ApplyOutcomes } from './ApplyOutcomes.js';
import { ApplyPanel } from './ApplyPanel.js';
import { DecisionBar, DecisionPrompt } from './DecisionBar.js';
import { FilterBar } from './FilterBar.js';
import { MessageDetailView, MessageList } from './MessageList.js';
import { ShortcutList, useKeyboardCommands } from './keyboard.js';
import { SignInAgain } from './SignInAgain.js';
import type { KeyboardCommand } from './keyboard-commands.js';

/** An open prompt: the Discard reason or Move destination for some Messages, or the shortcut list. */
type OpenPrompt = { kind: 'discard' | 'move'; handles: number[] } | { kind: 'shortcuts' };

export function CheckoutView({ id, onClose }: { id: string; onClose(): void }) {
  const [checkout, setCheckout] = useState<Checkout>();
  /** The focused Message: the one the Message view shows. */
  const [focused, setFocused] = useState<number>();
  const [detail, setDetail] = useState<MessageDetail>();
  const [error, setError] = useState<ApiError>();
  const [ending, setEnding] = useState(false);
  /** Date.now() when `checkout` arrived: the countdown runs from its remainingMs. */
  const [receivedAt, setReceivedAt] = useState(0);
  const [now, setNow] = useState(() => Date.now());
  /** The Selection: handles of the ticked Messages. */
  const [selection, setSelection] = useState<ReadonlySet<number>>(new Set());
  /** Handles matching the current filter; null when no filter is set. */
  const [matched, setMatched] = useState<ReadonlySet<number> | null>(null);
  /** The clauses of the current filter (what an export of the matching Messages sends). */
  const [clauses, setClauses] = useState<FilterClause[]>([]);
  const [exporting, setExporting] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string>();
  /** The Move destination picker's choices; a string says why they could not be loaded. */
  const [destinations, setDestinations] = useState<MoveDestinations | string>();
  const [prompt, setPrompt] = useState<OpenPrompt | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const filterRef = useRef<HTMLInputElement>(null);
  const profile = checkout?.profile;
  const vhost = checkout?.vhost;

  useEffect(() => {
    if (profile === undefined || vhost === undefined) return;
    let cancelled = false;
    api
      .moveDestinations(profile, vhost)
      .then((d) => !cancelled && setDestinations(d))
      .catch((err: ApiError) => !cancelled && setDestinations(err.message));
    return () => {
      cancelled = true;
    };
  }, [profile, vhost]);

  useEffect(() => {
    let cancelled = false;
    const received = (c: Checkout) => {
      if (cancelled) return;
      setCheckout(c);
      setReceivedAt(Date.now());
    };
    const failed = (err: ApiError) => !cancelled && setError(err);
    let timer: ReturnType<typeof setInterval> | undefined;
    api
      .heartbeat(id)
      .then((c) => {
        received(c);
        // The heartbeat also notices a Lost Checkout while the page is open.
        timer = setInterval(
          () => api.heartbeat(id).then(received).catch(failed),
          Math.max(1_000, Math.min(5_000, c.heartbeatWindowMs / 4)),
        );
      })
      .catch(failed);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [id]);

  useEffect(() => {
    const tick = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(tick);
  }, []);

  useEffect(() => {
    const end = () => navigator.sendBeacon(`/api/checkouts/${encodeURIComponent(id)}/end`);
    window.addEventListener('pagehide', end);
    return () => window.removeEventListener('pagehide', end);
  }, [id]);

  useEffect(() => {
    if (focused === undefined) return setDetail(undefined);
    let cancelled = false;
    api
      .message(id, focused)
      .then((m) => !cancelled && setDetail(m))
      .catch((err) => !cancelled && setError(err));
    return () => {
      cancelled = true;
    };
  }, [id, focused]);

  const end = async () => {
    setEnding(true);
    try {
      setCheckout(await api.endCheckout(id));
      onClose();
    } catch (err) {
      setError(err as ApiError);
    } finally {
      setEnding(false);
    }
  };

  const filter = async (clauses: FilterClause[]) => {
    setBusy(true);
    try {
      setMatched(new Set((await api.matching(id, clauses)).handles));
      setClauses(clauses);
      setError(undefined);
    } catch (err) {
      setError(err as ApiError);
    } finally {
      setBusy(false);
    }
  };

  /** Downloads the Messages matching the current filter, or every held one, as NDJSON. */
  const exportMessages = async (filtered: boolean) => {
    setExporting(true);
    try {
      await api.exportMessages(id, filtered ? clauses : undefined);
      setError(undefined);
    } catch (err) {
      setError(err as ApiError);
    } finally {
      setExporting(false);
    }
  };

  /** Assigns the Decision to the Messages: the Selection unless the keyboard named the focused Message. */
  const decide = async (decision: Decision, handles: number[] = [...selection]) => {
    if (handles.length === 0) return;
    setBusy(true);
    setNotice(undefined);
    try {
      const res = await api.setDecisions(id, handles, decision);
      setCheckout(res.checkout);
      setReceivedAt(Date.now());
      setError(undefined);
      const notices: string[] = [];
      if (res.rejected.length > 0) {
        notices.push(`${res.rejected.length} Message(s) kept their Decision: ${res.rejected[0]!.reason}`);
      }
      if (decision.kind === 'replay') {
        const diedAgain = res.checkout.messages.filter((m) => handles.includes(m.handle) && m.diedAgain).length;
        if (diedAgain > 0) notices.push(replayWarning(diedAgain));
      }
      if (notices.length > 0) setNotice(notices.join(' '));
    } catch (err) {
      setError(err as ApiError);
    } finally {
      setBusy(false);
    }
  };

  const apply = async (confirmQueueName?: string) => {
    setBusy(true);
    setNotice(undefined);
    try {
      const res = await api.apply(id, confirmQueueName);
      setCheckout(res.checkout);
      setReceivedAt(Date.now());
      setSelection(new Set());
      setError(undefined);
    } catch (err) {
      setError(err as ApiError);
    } finally {
      setBusy(false);
    }
  };

  /** Asks another Operator to approve the Apply, after the same confirmation as an Apply. */
  const requestApproval = async (confirmQueueName?: string) => {
    setBusy(true);
    setNotice(undefined);
    try {
      setCheckout(await api.requestApproval(id, confirmQueueName));
      setReceivedAt(Date.now());
      setError(undefined);
    } catch (err) {
      setError(err as ApiError);
    } finally {
      setBusy(false);
    }
  };

  const withdraw = async () => {
    setBusy(true);
    try {
      setCheckout(await api.withdrawApproval(id));
      setReceivedAt(Date.now());
      setError(undefined);
    } catch (err) {
      setError(err as ApiError);
    } finally {
      setBusy(false);
    }
  };

  const active = checkout?.status === 'active';
  const awaiting = checkout?.status === 'awaiting_approval';
  /** Still holding its Messages: active, or waiting for Approval. */
  const live = active || awaiting;
  /** The Messages the list shows: all of them, or those matching the filter. */
  const shown = checkout ? (matched ? checkout.messages.filter((m) => matched.has(m.handle)) : checkout.messages) : [];

  const run = (command: KeyboardCommand) => {
    switch (command.kind) {
      case 'move': {
        if (shown.length === 0) return;
        const at = shown.findIndex((m) => m.handle === focused);
        const next = shown[at < 0 ? 0 : Math.max(0, Math.min(shown.length - 1, at + command.by))]!.handle;
        if (command.extendSelection) setSelection((s) => new Set([...s, ...(focused === undefined ? [] : [focused]), next]));
        setFocused(next);
        listRef.current?.focus();
        return;
      }
      case 'toggle-selection':
        if (focused === undefined) return;
        return setSelection((s) => {
          const next = new Set(s);
          if (!next.delete(focused)) next.add(focused);
          return next;
        });
      case 'assign': {
        if (busy) return;
        const handles = command.to === 'selection' ? [...selection] : focused === undefined ? [] : [focused];
        if (command.decision === 'discard' || command.decision === 'move') {
          return setPrompt({ kind: command.decision, handles });
        }
        return void decide({ kind: command.decision }, handles);
      }
      case 'focus-filter':
        return filterRef.current?.focus();
      case 'clear-selection':
        return setSelection(new Set());
      case 'close-prompt':
        return setPrompt(null);
      case 'show-shortcuts':
        return setPrompt({ kind: 'shortcuts' });
      case 'start-checkout':
        return;
    }
  };
  useKeyboardCommands(
    active,
    {
      view: 'checkout',
      prompt: prompt !== null,
      selection: selection.size,
      // A Message the filter hides is not focused.
      focusedItem: shown.some((m) => m.handle === focused),
    },
    run,
  );

  if (!checkout) return error ? <ErrorBox error={error} /> : <p className="empty">Loading the Checkout…</p>;

  return (
    <section className={checkout.protectedProfile ? 'checkout protected' : 'checkout'}>
      <div className="checkout-head">
        <div>
          {checkout.protectedProfile && (
            <p className="protected-banner" role="note">
              <span className="badge protected-badge">Protected Profile</span> {checkout.profile}: changes here need
              the queue name typed to Apply.
            </p>
          )}
          <h2>
            Checkout of {checkout.queue} <span className={`badge type-${checkout.queueType}`}>{checkout.queueType}</span>
          </h2>
          <p className="who">
            {checkout.profile} · vhost {checkout.vhost} · started by {checkout.operator} at{' '}
            {new Date(checkout.startedAt).toLocaleTimeString()}
          </p>
          <p className="held">{heldLine(checkout)}</p>
          {checkout.diedAgainCount > 0 && (
            <p className="died-again-count">
              <span className="badge died-again">Died Again</span> {checkout.diedAgainCount} of the held Messages came
              back after a Replay, Move or Restore.
            </p>
          )}
          {live && (
            <p className="countdown" title={`Ends itself at ${new Date(checkout.endsAt).toLocaleTimeString()}`}>
              Ends in {formatCountdown(checkout.remainingMs - (now - receivedAt))}
            </p>
          )}
        </div>
        {live ? (
          <button onClick={end} disabled={ending} title={`Every held Message goes back to the queue ${returnOrder(checkout.queueType)}`}>
            End Checkout
          </button>
        ) : (
          <button onClick={onClose}>Back to queues</button>
        )}
      </div>

      {checkout.status === 'lost' && (
        <div className="error" role="alert">
          <strong>Lost Checkout</strong>
          <p>{checkout.lostReason}</p>
          <p>
            {checkout.lastApply
              ? 'Every Message whose Decision was not done is back in the queue.'
              : 'Every Message is back in the queue; nothing of this Checkout was applied.'}
          </p>
        </div>
      )}
      {checkout.status === 'ended' && <p className="empty">{endedLine(checkout)}</p>}
      {error && <ErrorBox error={error} />}
      {checkout.lastApply && <ApplyOutcomes outcomes={checkout.lastApply.outcomes} approvedBy={checkout.lastApply.approvedBy} />}

      {awaiting && checkout.approvalRequest && (
        <div className="awaiting-approval" role="status">
          <strong>Waiting for Approval</strong>
          <p>
            Requested at {new Date(checkout.approvalRequest.requestedAt).toLocaleTimeString()}: another Operator with the
            role <code>operator</code> or <code>admin</code> on {checkout.profile} must approve this Apply (
            {checkout.decisionSummaryText}). They find it under Approvals. Your Decisions cannot change until then.
          </p>
          <p>
            Keep this page open: closing it ends the Checkout, and with it the request. The Checkout's time limit keeps
            running.
          </p>
          <button onClick={withdraw} disabled={busy}>
            Withdraw request
          </button>
        </div>
      )}

      {active && checkout.messages.length > 0 && (
        <>
          <p className="decision-summary">
            <strong>Decisions:</strong> {checkout.decisionSummaryText}
          </p>
          <ApplyPanel
            profile={checkout.profile}
            protectedProfile={checkout.protectedProfile}
            queue={checkout.queue}
            queueType={checkout.queueType}
            typeQueueName={checkout.applyConfirmation.typeQueueName}
            approvalRequired={checkout.applyConfirmation.approvalRequired}
            summary={checkout.decisionSummary}
            summaryText={checkout.decisionSummaryText}
            busy={busy}
            onApply={checkout.applyConfirmation.approvalRequired ? requestApproval : apply}
          />
          <DecisionBar
            selected={selection.size}
            replayUnavailable={checkout.messages.filter((m) => selection.has(m.handle) && !m.replay.available).length}
            busy={busy}
            onPrompt={(kind) => setPrompt({ kind, handles: [...selection] })}
            onDecide={(decision) => void decide(decision)}
            onClearSelection={() => setSelection(new Set())}
          />
          {prompt && prompt.kind !== 'shortcuts' && (
            <DecisionPrompt
              kind={prompt.kind}
              count={prompt.handles.length}
              sourceQueue={checkout.queue}
              destinations={destinations}
              busy={busy}
              onDecide={(decision) => void decide(decision, prompt.handles)}
              onClose={() => setPrompt(null)}
            />
          )}
          {notice && <p className="notice">{notice}</p>}
          <p className="export">
            <button
              disabled={exporting}
              onClick={() => exportMessages(false)}
              title="Download every held Message as NDJSON, one line each (recorded as an Audit Entry)"
            >
              {exporting ? 'Exporting…' : `Export all ${checkout.messages.length} Messages`}
            </button>
          </p>
          <FilterBar
            active={matched !== null}
            busy={busy}
            onFilter={filter}
            onClear={() => setMatched(null)}
            firstFieldRef={filterRef}
          />
          {matched && (
            <div className="filter-result">
              <span>
                {matched.size} of {checkout.messages.length} Messages match the filter
              </span>
              <button
                disabled={matched.size === 0}
                onClick={() => setSelection((s) => new Set([...s, ...matched]))}
              >
                Select all {matched.size} matching
              </button>
              <button
                disabled={matched.size === 0 || exporting}
                onClick={() => exportMessages(true)}
                title="Download the matching Messages as NDJSON (recorded as an Audit Entry)"
              >
                Export {matched.size} matching
              </button>
            </div>
          )}
        </>
      )}

      {awaiting && (
        <p className="decision-summary">
          <strong>Decisions:</strong> {checkout.decisionSummaryText}
        </p>
      )}

      {live && (
        <div className="checkout-body">
          <MessageList
            listRef={listRef}
            messages={shown}
            empty={matched ? 'No Message matches the filter.' : 'The queue had no ready Messages.'}
            quorum={checkout.queueType === 'quorum' && checkout.deliveryLimit !== null}
            focused={focused}
            onFocus={setFocused}
            selection={active ? selection : undefined}
            onSelection={active ? setSelection : undefined}
          />
          {detail && <MessageDetailView message={detail} />}
        </div>
      )}
      {active && (
        <p className="muted shortcut-hint">
          Press <kbd>?</kbd> for keyboard shortcuts.
        </p>
      )}
      {prompt?.kind === 'shortcuts' && <ShortcutList onClose={() => setPrompt(null)} />}
    </section>
  );
}

function formatCountdown(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

function endedLine(c: Checkout): string {
  const back = `its Messages are back in the queue ${returnOrder(c.queueType)}.`;
  switch (c.endReason) {
    case 'time-limit':
      return `This Checkout reached its time limit of ${Math.round(c.timeLimitMs / 60_000)} minutes and ended; ${back}`;
    case 'no-heartbeat':
      return `This Checkout ended because this page stopped sending heartbeats; ${back}`;
    case 'applied':
      return `This Checkout was Applied; the Messages not done are back in the queue ${returnOrder(c.queueType)}.`;
    case 'shutdown':
      return `This Checkout ended because ${product.name} shut down; ${back}`;
    default:
      return `This Checkout has ended; ${back}`;
  }
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

function replayWarning(diedAgain: number): string {
  return `${diedAgain} of these Messages already died again after being sent back: their consumer failed on them before. Replay them only once the cause is fixed.`;
}
