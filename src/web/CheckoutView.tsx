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
import { useEffect, useRef, useState, type Ref } from 'react';
import { decisionLabel } from '../shared/decisions.js';
import { formatBytes, heldLine } from '../shared/held-line.js';
import { product } from '../shared/product.js';
import { returnOrder } from '../shared/return-order.js';
import {
  api,
  ApiError,
  type Checkout,
  type Decision,
  type DiedAgain,
  type FilterClause,
  type MessageDetail,
  type MessageRow,
  type MoveDestinations,
} from './api.js';
import { ApplyOutcomes } from './ApplyOutcomes.js';
import { ApplyPanel } from './ApplyPanel.js';
import { DecisionBar, DecisionPrompt } from './DecisionBar.js';
import { DecisionBadge } from './decisions.js';
import { FilterBar } from './FilterBar.js';
import { ShortcutList, useKeyboardCommands } from './keyboard.js';
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
      setError(undefined);
    } catch (err) {
      setError(err as ApiError);
    } finally {
      setBusy(false);
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

  const active = checkout?.status === 'active';
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
          {active && (
            <p className="countdown" title={`Ends itself at ${new Date(checkout.endsAt).toLocaleTimeString()}`}>
              Ends in {formatCountdown(checkout.remainingMs - (now - receivedAt))}
            </p>
          )}
        </div>
        {active ? (
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
      {checkout.lastApply && <ApplyOutcomes outcomes={checkout.lastApply.outcomes} />}

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
            summary={checkout.decisionSummary}
            summaryText={checkout.decisionSummaryText}
            busy={busy}
            onApply={apply}
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
            </div>
          )}
        </>
      )}

      {active && (
        <div className="checkout-body">
          <MessageList
            listRef={listRef}
            messages={shown}
            empty={matched ? 'No Message matches the filter.' : 'The queue had no ready Messages.'}
            quorum={checkout.queueType === 'quorum' && checkout.deliveryLimit !== null}
            focused={focused}
            onFocus={setFocused}
            selection={selection}
            onSelection={setSelection}
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
    </div>
  );
}

const optionId = (handle: number) => `message-${handle}`;

/** How a screen reader announces a Message when it gets the focus. */
function messageLabel(m: MessageRow): string {
  return [
    m.messageId ?? 'Message without message_id',
    decisionLabel(m.decision),
    `routing key ${m.routingKey}`,
    m.deadLetterReason && `dead-lettered: ${m.deadLetterReason}`,
    !m.replay.available && 'no Replay',
    m.diedAgain && `Died Again ${timesText(m.diedAgain.count)}`,
  ]
    .filter(Boolean)
    .join(', ');
}

/**
 * The held Messages as a listbox: the list keeps the DOM focus and the
 * focused Message is its active descendant; a Message in the Selection is
 * aria-selected. The table inside only lays the rows out.
 */
function MessageList(props: {
  listRef: Ref<HTMLDivElement>;
  messages: MessageRow[];
  empty: string;
  quorum: boolean;
  focused: number | undefined;
  onFocus(handle: number): void;
  selection: ReadonlySet<number>;
  onSelection(selection: ReadonlySet<number>): void;
}) {
  useEffect(() => {
    if (props.focused !== undefined) document.getElementById(optionId(props.focused))?.scrollIntoView({ block: 'nearest' });
  }, [props.focused]);
  if (props.messages.length === 0) return <p className="empty">{props.empty}</p>;
  const allTicked = props.messages.every((m) => props.selection.has(m.handle));
  const tick = (handles: number[], on: boolean) => {
    const next = new Set(props.selection);
    for (const h of handles) {
      if (on) next.add(h);
      else next.delete(h);
    }
    props.onSelection(next);
  };
  const focusedShown = props.messages.some((m) => m.handle === props.focused);
  return (
    <div className="message-list">
      <label className="checkbox">
        <input
          type="checkbox"
          checked={allTicked}
          onChange={() => tick(props.messages.map((m) => m.handle), !allTicked)}
        />
        Select all {props.messages.length} shown Messages
      </label>
      <div
        ref={props.listRef}
        className="listbox"
        role="listbox"
        aria-label="Held Messages"
        aria-multiselectable="true"
        tabIndex={0}
        aria-activedescendant={focusedShown ? optionId(props.focused!) : undefined}
        onFocus={(e) => {
          // Tabbing into the list focuses its first Message, so there is always one to announce.
          if (e.target === e.currentTarget && !focusedShown) props.onFocus(props.messages[0]!.handle);
        }}
      >
        <table className="queues messages" role="presentation">
          <thead aria-hidden="true">
            <tr>
              <th className="select" />
              <th>Decision</th>
              <th>message_id</th>
              <th>Routing key</th>
              <th>Timestamp</th>
              <th>Dead-letter reason</th>
              <th>Original queue</th>
              {props.quorum && <th className="num">Delivery Budget</th>}
            </tr>
          </thead>
          <tbody>
            {props.messages.map((m) => (
              <tr
                key={m.handle}
                id={optionId(m.handle)}
                role="option"
                aria-selected={props.selection.has(m.handle)}
                aria-label={messageLabel(m)}
                className={m.handle === props.focused ? 'match focused' : undefined}
                onClick={() => props.onFocus(m.handle)}
              >
                {/* The ticked state reaches screen readers as aria-selected; the box is for the mouse. */}
                <td className="select" aria-hidden="true" onClick={(e) => e.stopPropagation()}>
                  <input
                    type="checkbox"
                    tabIndex={-1}
                    checked={props.selection.has(m.handle)}
                    onChange={(e) => tick([m.handle], e.target.checked)}
                  />
                </td>
                <td>
                  <DecisionBadge decision={m.decision} />
                  {!m.replay.available && (
                    <span className="badge" title={m.replay.reason}>
                      no Replay
                    </span>
                  )}
                  {m.diedAgain && <DiedAgainBadge diedAgain={m.diedAgain} />}
                </td>
                <td className="name">{m.messageId ?? <em>none</em>}</td>
                <td>{m.routingKey}</td>
                <td>{m.timestamp ? new Date(m.timestamp).toLocaleString() : ''}</td>
                <td>{m.deadLetterReason ?? ''}</td>
                <td>{m.originalQueue ?? ''}</td>
                {props.quorum && (
                  <td className="num">
                    {m.deliveryBudget?.remaining ?? ''}
                    {m.deliveryBudget?.warning && (
                      <span className="badge limit-warning" title={m.deliveryBudget.warning}>
                        ⚠
                      </span>
                    )}
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

const ACTION_DONE: Record<NonNullable<DiedAgain['last']>['action'], string> = {
  replay: 'Replayed',
  move: 'Moved',
  restore: 'Restored',
};

const timesText = (count: number) => (count === 1 ? 'once' : `${count} times`);

function replayWarning(diedAgain: number): string {
  return `${diedAgain} of these Messages already died again after being sent back: their consumer failed on them before. Replay them only once the cause is fixed.`;
}

/** The Audit Entry, as the API returns it (the web app has no page for one entry). */
function AuditEntryLink({ id }: { id: number }) {
  return (
    <a href={`/api/audit-entries/${id}`} target="_blank" rel="noreferrer">
      Audit Entry {id}
    </a>
  );
}

function DiedAgainBadge({ diedAgain: d }: { diedAgain: DiedAgain }) {
  const how = d.last
    ? `${ACTION_DONE[d.last.action]} by ${d.last.operatorName} on ${new Date(d.last.at).toLocaleString()} (Audit Entry ${d.last.auditEntryId})`
    : 'No Audit Entry here has its replay id';
  return (
    <span className="badge died-again" title={`Died Again ${timesText(d.count)}. ${how}.`}>
      Died Again{d.count > 1 ? ` ×${d.count}` : ''}
    </span>
  );
}

/** The Message view's account of a Died Again Message, linked to the Audit Entry that last sent it out. */
function DiedAgainNote({ diedAgain: d }: { diedAgain: DiedAgain }) {
  return (
    <div className="warning died-again-note">
      <p>
        <strong>Died Again {timesText(d.count)}.</strong>{' '}
        {d.last ? (
          <>
            {ACTION_DONE[d.last.action]} from {d.last.fromQueue} by {d.last.operatorName} on{' '}
            {new Date(d.last.at).toLocaleString()} (<AuditEntryLink id={d.last.auditEntryId} />), then dead-lettered
            again.
          </>
        ) : (
          <>
            No Audit Entry here has its replay id <code>{d.replayId}</code>: another {product.name} instance may have sent
            it out.
          </>
        )}
      </p>
      <p>Its consumer already failed on it after it was sent back: Replay it only once the cause is fixed.</p>
    </div>
  );
}

function MessageDetailView({ message: m }: { message: MessageDetail }) {
  return (
    <div className="message-detail">
      <h3>{m.messageId ?? 'Message without message_id'}</h3>
      {m.diedAgain && <DiedAgainNote diedAgain={m.diedAgain} />}
      {m.deliveryBudget?.warning && (
        <div className="warning">
          <p>{m.deliveryBudget.warning}</p>
        </div>
      )}
      <dl>
        <dt>Exchange</dt>
        <dd>{m.exchange === '' ? '(default)' : m.exchange}</dd>
        <dt>Routing key</dt>
        <dd>{m.routingKey}</dd>
        <dt>Redelivered</dt>
        <dd>{m.redelivered ? 'yes' : 'no'}</dd>
        {m.deliveryLimit !== null && (
          <>
            <dt>Deliveries</dt>
            <dd>
              {m.deliveryCount ?? 0} of {m.deliveryLimit}
            </dd>
          </>
        )}
      </dl>

      <h4>Properties</h4>
      <pre>{JSON.stringify(m.properties, null, 2)}</pre>

      {m.xDeath.length > 0 && (
        <>
          <h4>Dead-letter history (x-death, most recent first)</h4>
          <table className="queues">
            <thead>
              <tr>
                <th>Queue</th>
                <th>Reason</th>
                <th className="num">Count</th>
                <th>First time</th>
                <th>Exchange</th>
                <th>Routing keys</th>
              </tr>
            </thead>
            <tbody>
              {m.xDeath.map((d, i) => (
                <tr key={i}>
                  <td>{d.queue}</td>
                  <td>{d.reason}</td>
                  <td className="num">{d.count}</td>
                  <td>{d.time ? new Date(d.time).toLocaleString() : ''}</td>
                  <td>{d.exchange}</td>
                  <td>{d.routingKeys.join(', ')}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}

      <h4>Headers</h4>
      <pre>{JSON.stringify(m.headers, null, 2)}</pre>

      <h4>
        Body <small>({formatBytes(m.body.size)}, {m.body.kind})</small>
      </h4>
      {m.body.kind === 'binary' ? (
        <>
          <h5>Hex</h5>
          <pre className="wrap">{m.body.hex}</pre>
          <h5>Base64</h5>
          <pre className="wrap">{m.body.base64}</pre>
        </>
      ) : (
        <pre>{m.body.text}</pre>
      )}
    </div>
  );
}
