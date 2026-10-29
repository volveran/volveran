// The held Messages of a Checkout as a list (with the Selection, for the
// owner) and the Message view of one of them. Shared by the owner's Checkout
// view and the approver's read-only view of a waiting Checkout.
import { Fragment, useEffect, type Ref } from 'react';
import { decisionLabel } from '../shared/decisions.js';
import { formatBytes } from '../shared/held-line.js';
import { product } from '../shared/product.js';
import type { DiedAgain, FailureDetails, MessageDetail, MessageRow, RuleBadge } from './api.js';
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
    m.failureDetails?.reason === 'skip' && 'skipped',
    m.diedAgain && `Died Again ${timesText(m.diedAgain.count)}`,
    m.rule && ruleText(m.rule),
  ]
    .filter(Boolean)
    .join(', ');
}

/**
 * The held Messages as a listbox: the list keeps the DOM focus and the
 * focused Message is its active descendant; a Message in the Selection is
 * aria-selected. The table inside only lays the rows out. Without
 * `onSelection` there is no Selection (an approver ticks Messages only to compare them).
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
                  {m.diedAgain && <DiedAgainBadge diedAgain={m.diedAgain} />}
                  {m.failureDetails?.reason === 'skip' && <SkippedBadge />}
                  {m.rule && <RuleBadgeView rule={m.rule} />}
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

/** "Replay rule transient-payments: attempt 1 of 3, next after 10/29/2026, 3:00 AM", or "…: attempts used up". */
function ruleText(r: RuleBadge): string {
  if (r.usedUp) return `Replay rule ${r.name}: attempts used up (${r.attempts} of ${r.maxAttempts})`;
  const next = r.nextAttemptAt ? `, next after ${new Date(r.nextAttemptAt).toLocaleString()}` : '';
  return `Replay rule ${r.name}: ${r.attempts} of ${r.maxAttempts} attempts used${next}`;
}

/** A running Replay Rule matches the Message: its attempts, or that it has given up on it. */
function RuleBadgeView({ rule: r }: { rule: RuleBadge }) {
  return (
    <span className={`badge rule${r.usedUp ? ' used-up' : ''}`} title={ruleText(r)}>
      {r.usedUp ? 'attempts used up' : `rule ${r.attempts}/${r.maxAttempts}`}
    </span>
  );
}

/** The Message view's account of the Replay Rule that matches the Message. */
function RuleNote({ rule: r }: { rule: RuleBadge }) {
  return (
    <div className={r.usedUp ? 'warning rule-note' : 'notice rule-note'}>
      <p>
        <RuleBadgeView rule={r} /> {ruleText(r)}.
        {r.usedUp && ' The rule has given up on this Message: it needs a person.'}
      </p>
    </div>
  );
}

const ACTION_DONE: Record<NonNullable<DiedAgain['last']>['action'], string> = {
  replay: 'Replayed',
  move: 'Moved',
  restore: 'Restored',
};

const timesText = (count: number) => (count === 1 ? 'once' : `${count} times`);

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

function SkippedBadge() {
  return (
    <span className="badge skipped" title="MassTransit skipped this Message (MT-Reason: skip): no consumer handled its type.">
      skipped
    </span>
  );
}

const FRAMEWORK_NAME: Record<FailureDetails['framework'], string> = { spring: 'Spring AMQP', masstransit: 'MassTransit' };

/** The Message view's Failure Details: what Spring AMQP or MassTransit wrote, the stack trace collapsed. */
function FailureDetailsSection({ details: f }: { details: FailureDetails }) {
  const rows: Array<[string, string | number | null]> = [
    ['Exception type', f.exceptionType],
    ['Message', f.message],
    ['Consumer type', f.consumerType],
    ['Message type', f.messageType],
    ['Failed at', f.failedAt && !Number.isNaN(Date.parse(f.failedAt)) ? new Date(f.failedAt).toLocaleString() : f.failedAt],
    ['Retries', f.retryCount],
    ['Redeliveries', f.redeliveryCount],
    ['Input queue', f.inputQueue],
    ['Original exchange', f.originalExchange === '' ? '(default)' : f.originalExchange],
    ['Original routing key', f.originalRoutingKey],
    ...Object.entries(f.host ?? {}).map(([name, value]): [string, string] => [`Host ${name}`, value]),
    ...Object.entries(f.extra),
  ];
  return (
    <section className="failure-details">
      <h4>
        Failure Details <small>({FRAMEWORK_NAME[f.framework]})</small>
      </h4>
      {f.reason === 'skip' && (
        <p>
          <span className="badge skipped">skipped</span> MassTransit skipped this Message: no consumer handled its type. It
          is not a fault.
        </p>
      )}
      <dl>
        {rows
          .filter(([, value]) => value !== null)
          .map(([label, value]) => (
            <Fragment key={label}>
              <dt>{label}</dt>
              <dd>{value}</dd>
            </Fragment>
          ))}
      </dl>
      {f.stackTrace !== null && (
        <details>
          <summary>Stack trace</summary>
          <pre>{f.stackTrace}</pre>
        </details>
      )}
    </section>
  );
}

export function MessageDetailView({ message: m }: { message: MessageDetail }) {
  return (
    <div className="message-detail">
      <h3>{m.messageId ?? 'Message without message_id'}</h3>
      {m.diedAgain && <DiedAgainNote diedAgain={m.diedAgain} />}
      {m.rule && <RuleNote rule={m.rule} />}
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

      {m.failureDetails && <FailureDetailsSection details={m.failureDetails} />}

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
