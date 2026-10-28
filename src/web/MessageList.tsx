// The held Messages of a Checkout as a list (with the Selection, for the
// owner) and the Message view of one of them. Shared by the owner's Checkout
// view and the approver's read-only view of a waiting Checkout.
import { useEffect, type Ref } from 'react';
import { decisionLabel } from '../shared/decisions.js';
import { formatBytes } from '../shared/held-line.js';
import type { MessageDetail, MessageRow } from './api.js';
import { DecisionBadge } from './decisions.js';

const optionId = (handle: number) => `message-${handle}`;

/** How a screen reader announces a Message when it gets the focus. */
function messageLabel(m: MessageRow): string {
  return [
    m.messageId ?? 'Message without message_id',
    decisionLabel(m.decision),
    `routing key ${m.routingKey}`,
    m.deadLetterReason && `dead-lettered: ${m.deadLetterReason}`,
    !m.replay.available && 'no Replay',
  ]
    .filter(Boolean)
    .join(', ');
}

/**
 * The held Messages as a listbox: the list keeps the DOM focus and the
 * focused Message is its active descendant; a Message in the Selection is
 * aria-selected. The table inside only lays the rows out. Without
 * `onSelection` (an approver's read-only view) there is no Selection.
 */
export function MessageList(props: {
  listRef?: Ref<HTMLDivElement>;
  messages: MessageRow[];
  empty: string;
  quorum: boolean;
  focused: number | undefined;
  onFocus(handle: number): void;
  selection?: ReadonlySet<number>;
  onSelection?(selection: ReadonlySet<number>): void;
}) {
  const selection = props.selection ?? new Set<number>();
  const selectable = props.onSelection !== undefined;
  useEffect(() => {
    if (props.focused !== undefined) document.getElementById(optionId(props.focused))?.scrollIntoView({ block: 'nearest' });
  }, [props.focused]);
  if (props.messages.length === 0) return <p className="empty">{props.empty}</p>;
  const allTicked = props.messages.every((m) => selection.has(m.handle));
  const tick = (handles: number[], on: boolean) => {
    const next = new Set(selection);
    for (const h of handles) {
      if (on) next.add(h);
      else next.delete(h);
    }
    props.onSelection?.(next);
  };
  const focusedShown = props.messages.some((m) => m.handle === props.focused);
  return (
    <div className="message-list">
      {selectable && (
        <label className="checkbox">
          <input
            type="checkbox"
            checked={allTicked}
            onChange={() => tick(props.messages.map((m) => m.handle), !allTicked)}
          />
          Select all {props.messages.length} shown Messages
        </label>
      )}
      <div
        ref={props.listRef}
        className="listbox"
        role="listbox"
        aria-label="Held Messages"
        aria-multiselectable={selectable}
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
              {selectable && <th className="select" />}
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
                aria-selected={selectable ? selection.has(m.handle) : undefined}
                aria-label={messageLabel(m)}
                className={m.handle === props.focused ? 'match focused' : undefined}
                onClick={() => props.onFocus(m.handle)}
              >
                {/* The ticked state reaches screen readers as aria-selected; the box is for the mouse. */}
                {selectable && (
                  <td className="select" aria-hidden="true" onClick={(e) => e.stopPropagation()}>
                    <input
                      type="checkbox"
                      tabIndex={-1}
                      checked={selection.has(m.handle)}
                      onChange={(e) => tick([m.handle], e.target.checked)}
                    />
                  </td>
                )}
                <td>
                  <DecisionBadge decision={m.decision} />
                  {!m.replay.available && (
                    <span className="badge" title={m.replay.reason}>
                      no Replay
                    </span>
                  )}
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

export function MessageDetailView({ message: m }: { message: MessageDetail }) {
  return (
    <div className="message-detail">
      <h3>{m.messageId ?? 'Message without message_id'}</h3>
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
