// A Checkout: how many Messages it holds, the list of held Messages with
// their Decisions, the Selection (ticked by hand or "Select all matching" a
// filter) and the detail of the Message being looked at. Ending it returns every Message to the queue;
// leaving the page ends it too (a beacon), so nothing stays held by accident.
// While the page shows the Checkout it sends heartbeats (without them the
// server ends it), and it counts down to the Checkout's time limit. Apply
// carries out the Decisions in the background and ends the Checkout: while
// it runs the page polls the Checkout and shows its progress (with Stop,
// after a confirmation), then what happened to each Message. The keyboard moves through the Messages (the
// Message view follows), builds the Selection and assigns Decisions; the
// keys are mapped to commands in keyboard-commands.ts. With exactly two
// Messages selected, Compare (or `c`) shows them side by side in place of the
// list, with Decision buttons for each.
//
// When the Apply needs Approval (Team Mode, a Protected Profile), the Apply
// confirmation requests it instead; the Checkout then waits, its Decisions
// frozen, until another Operator approves it (the heartbeat brings the
// outcome back here), rejects it (the reason shows here, and the Checkout is
// back in staging), or the Operator withdraws the request. While it waits
// the page shows the time left and a link to paste in chat for an approver.
import { useEffect, useRef, useState } from 'react';
import { approvalLink } from '../shared/approval-link.js';
import { heldLine } from '../shared/held-line.js';
import { product } from '../shared/product.js';
import { rateText } from '../shared/replay-rate.js';
import { returnOrder } from '../shared/return-order.js';
import {
  api,
  ApiError,
  type Checkout,
  type Decision,
  type FilterClause,
  type MessageDetail,
  type MoveDestination,
  type MoveDestinations,
  type CanaryChoice,
} from './api.js';
import { ApplyOutcomes } from './ApplyOutcomes.js';
import { ApplyPanel } from './ApplyPanel.js';
import { ApplyProgressPanel } from './ApplyProgress.js';
import { CanaryPanel, requestedCanaryText } from './CanaryPanel.js';
import { ComparisonView } from './ComparisonView.js';
import { formatCountdown } from './countdown.js';
import { DecisionBar, DecisionPrompt } from './DecisionBar.js';
import { FilterBar } from './FilterBar.js';
import { MessageDetailView, MessageList } from './MessageList.js';
import { ShortcutList, useKeyboardCommands } from './keyboard.js';
import { ErrorBox } from './ErrorBox.js';
import { useNow, usePolling } from './timers.js';
import type { KeyboardCommand } from './keyboard-commands.js';

/** An open prompt: the Discard reason or Move destination for some Messages, the Apply confirmation, or the shortcut list. */
type OpenPrompt = { kind: 'discard' | 'move'; handles: number[] } | { kind: 'apply' } | { kind: 'shortcuts' };

/** `hidden`: the page shows another view (Approvals) meanwhile; the Checkout keeps its heartbeat, its keys are off. */
export function CheckoutView({ id, hidden = false, onClose }: { id: string; hidden?: boolean; onClose(): void }) {
  const [checkout, setCheckout] = useState<Checkout>();
  /** The focused Message: the one the Message view shows. */
  const [focused, setFocused] = useState<number>();
  const [detail, setDetail] = useState<MessageDetail>();
  const [error, setError] = useState<ApiError>();
  const [ending, setEnding] = useState(false);
  /** Date.now() when `checkout` arrived: the countdown runs from its remainingMs. */
  const [receivedAt, setReceivedAt] = useState(0);
  const now = useNow();
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
  /** The two Messages being compared, in Checkout order; null when the list shows. */
  const [comparing, setComparing] = useState<readonly [number, number] | null>(null);
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

  // The heartbeat also notices a Lost Checkout while the page is open.
  usePolling(
    {
      load: () => api.heartbeat(id),
      received: (c: Checkout) => {
        setCheckout(c);
        setReceivedAt(Date.now());
      },
      failed: setError,
      everyMs: (c) => Math.max(1_000, Math.min(5_000, c.heartbeatWindowMs / 4)),
    },
    [id],
  );

  // While the Apply runs (a Lost Checkout's included, until its outcomes arrive), follow its progress.
  const applying = checkout?.status === 'applying' || (checkout?.applyProgress != null && checkout.lastApply === null);
  usePolling(
    {
      load: () => api.checkout(id),
      received: (c: Checkout) => {
        setCheckout(c);
        setReceivedAt(Date.now());
      },
      failed: setError,
      everyMs: APPLY_POLL_MS,
      enabled: applying,
    },
    [id, applying],
  );

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

  const apply = async (confirmQueueName?: string, rate?: number, canary?: CanaryChoice) => {
    setBusy(true);
    setNotice(undefined);
    try {
      setCheckout(await api.apply(id, confirmQueueName, rate, canary));
      setReceivedAt(Date.now());
      setSelection(new Set());
      setError(undefined);
    } catch (err) {
      setError(err as ApiError);
    } finally {
      setBusy(false);
    }
  };

  /** Stops the running Apply, after its confirmation. */
  const stopApply = async () => {
    try {
      setCheckout(await api.stopApply(id));
      setReceivedAt(Date.now());
      setError(undefined);
    } catch (err) {
      setError(err as ApiError);
    }
  };

  /** Lets the Apply waiting after its Canary carry out the rest. */
  const continueApply = async () => {
    try {
      setCheckout(await api.continueApply(id));
      setReceivedAt(Date.now());
      setError(undefined);
    } catch (err) {
      setError(err as ApiError);
    }
  };

  /** Asks another Operator to approve the Apply, after the same confirmation as an Apply. */
  const requestApproval = async (confirmQueueName?: string, rate?: number, canary?: CanaryChoice) => {
    setBusy(true);
    setNotice(undefined);
    try {
      setCheckout(await api.requestApproval(id, confirmQueueName, rate, canary));
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
  /** Still holding its Messages: active, waiting for Approval, or Applying. */
  const live = active || awaiting || checkout?.status === 'applying';
  /** The Messages the list shows: all of them, or those matching the filter. */
  const shown = checkout ? (matched ? checkout.messages.filter((m) => matched.has(m.handle)) : checkout.messages) : [];

  /** Compares the two selected Messages. */
  const compare = () => {
    const pair = (checkout?.messages ?? []).filter((m) => selection.has(m.handle)).map((m) => m.handle);
    if (pair.length === 2) setComparing([pair[0]!, pair[1]!]);
  };

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
        return prompt ? setPrompt(null) : setComparing(null);
      case 'compare':
        return compare();
      case 'show-shortcuts':
        return setPrompt({ kind: 'shortcuts' });
      case 'start-checkout':
        return;
    }
  };
  useKeyboardCommands(
    active && !hidden,
    {
      view: 'checkout',
      // The comparison takes the keys like a prompt: Escape closes it.
      prompt: prompt !== null || comparing !== null,
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
          <button
            onClick={end}
            disabled={ending || applying}
            title={
              applying
                ? 'The Apply ends the Checkout once it has run'
                : `Every held Message goes back to the queue ${returnOrder(checkout.queueType)}`
            }
          >
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
      {checkout.canary && (
        <CanaryPanel
          canary={checkout.canary}
          progress={applying ? checkout.applyProgress : null}
          now={now}
          onContinue={continueApply}
          onStop={stopApply}
        />
      )}
      {applying && checkout.applyProgress && (
        <ApplyProgressPanel progress={checkout.applyProgress} now={now} onStop={stopApply} />
      )}
      {checkout.lastApply && <ApplyOutcomes outcomes={checkout.lastApply.outcomes} approvedBy={checkout.lastApply.approvedBy} />}

      {awaiting && checkout.approvalRequest && (
        <div className="awaiting-approval" role="status">
          <strong>Waiting for Approval</strong>
          <p>
            Requested at {new Date(checkout.approvalRequest.requestedAt).toLocaleTimeString()}: another Operator with the
            role <code>operator</code> or <code>admin</code> on {checkout.profile} must approve this Apply (
            {checkout.decisionSummaryText}, {rateText(checkout.approvalRequest.rate)}
            {checkout.approvalRequest.canary && `; ${requestedCanaryText(checkout.approvalRequest.canary)}`}). They find it
            under Approvals. Your Decisions, the rate and the Canary cannot change until then.
          </p>
          <p>
            <strong>{formatCountdown(checkout.remainingMs - (now - receivedAt))} left</strong> before the Checkout reaches
            its time limit and ends, and with it the request. Keep this page open: closing it ends the Checkout too.
          </p>
          <CopyableLink label="Link for an approver" url={approvalLink(window.location.origin, checkout.id)} />
          <button onClick={withdraw} disabled={busy}>
            Withdraw request
          </button>
        </div>
      )}
      {active && checkout.rejection && (
        <div className="rejection" role="alert">
          <strong>
            Approval rejected by {checkout.rejection.rejectedBy} at {new Date(checkout.rejection.at).toLocaleTimeString()}
          </strong>
          <p className="rejection-reason">{checkout.rejection.reason}</p>
          <p>Change the Decisions, then request Approval again.</p>
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
            replayRate={checkout.applyConfirmation.replayRate}
            canary={checkout.applyConfirmation.canary}
            messageLabel={(handle) => checkout.messages.find((m) => m.handle === handle)?.messageId ?? `Message ${handle}`}
            summary={checkout.decisionSummary}
            summaryText={checkout.decisionSummaryText}
            busy={busy}
            onApply={checkout.applyConfirmation.approvalRequired ? requestApproval : apply}
            confirming={prompt?.kind === 'apply'}
            onConfirming={(open) => setPrompt(open ? { kind: 'apply' } : null)}
          />
          <DecisionBar
            selected={selection.size}
            replayUnavailable={checkout.messages.filter((m) => selection.has(m.handle) && !m.replay.available).length}
            busy={busy}
            onPrompt={(kind) => setPrompt({ kind, handles: [...selection] })}
            onDecide={(decision) => void decide(decision)}
            onClearSelection={() => setSelection(new Set())}
            onCompare={compare}
          />
          {(prompt?.kind === 'discard' || prompt?.kind === 'move') && (
            <DecisionPrompt
              kind={prompt.kind}
              count={prompt.handles.length}
              sourceQueue={checkout.queue}
              destinations={destinations}
              suggestedMove={sharedSuggestedMove(checkout.messages, prompt.handles)}
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

      {live && comparing && (
        <ComparisonView
          source="checkout"
          id={checkout.id}
          handles={comparing}
          rows={checkout.messages}
          actions={
            active
              ? {
                  busy,
                  onPrompt: (kind, handle) => setPrompt({ kind, handles: [handle] }),
                  onDecide: (decision, handle) => void decide(decision, [handle]),
                }
              : undefined
          }
          onClose={() => setComparing(null)}
        />
      )}
      {live && !comparing && (
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

/** A link shown in full, with a button that copies it (the text stays selectable where the clipboard is not available). */
function CopyableLink({ label, url }: { label: string; url: string }) {
  const [copied, setCopied] = useState(false);
  const copy = () => {
    navigator.clipboard?.writeText(url).then(
      () => setCopied(true),
      () => setCopied(false),
    );
  };
  return (
    <p className="copyable-link">
      <label>
        <span>{label}</span>
        <input readOnly value={url} onFocus={(e) => e.currentTarget.select()} aria-label={label} spellCheck={false} />
      </label>
      <button type="button" onClick={copy}>
        {copied ? 'Copied' : 'Copy link'}
      </button>
    </p>
  );
}

/** How often the page reads the Checkout while its Apply runs. */
const APPLY_POLL_MS = 1_000;

function endedLine(c: Checkout): string {
  const back = `its Messages are back in the queue ${returnOrder(c.queueType)}.`;
  switch (c.endReason) {
    case 'time-limit':
      if (c.lastApply) {
        return `This Checkout reached its time limit of ${Math.round(c.timeLimitMs / 60_000)} minutes during the Apply, which stopped before its next step; the Messages not done are back in the queue ${returnOrder(c.queueType)}.`;
      }
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

function replayWarning(diedAgain: number): string {
  return `${diedAgain} of these Messages already died again after being sent back: their consumer failed on them before. Replay them only once the cause is fixed.`;
}

/** The Move every one of `handles` suggests (where Spring AMQP first published it), when they all suggest the same one. */
function sharedSuggestedMove(messages: Checkout['messages'], handles: number[]): MoveDestination | null {
  let shared: MoveDestination | null = null;
  for (const handle of handles) {
    const replay = messages.find((m) => m.handle === handle)?.replay;
    const suggested = replay && !replay.available ? replay.suggestedMove : undefined;
    if (!suggested) return null;
    if (shared && JSON.stringify(shared) !== JSON.stringify(suggested)) return null;
    shared = suggested;
  }
  return shared;
}
