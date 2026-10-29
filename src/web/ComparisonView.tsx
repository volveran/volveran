// Two Messages side by side (GET …/compare): properties, headers, the
// x-death history, Failure Details and the body lined up in two columns,
// with what differs highlighted. "Hide equal" leaves only the differences;
// it starts on when a body is over 50 lines. In a Checkout each side has
// its Decision buttons; from an Approval the Decisions are only shown.
import { useEffect, useState } from 'react';
import type { MessageComparison, FieldDiff, BodyDiff, TextHunk } from '../shared/message-diff.js';
import { api, ApiError, type Decision, type MessageDetail, type MessageRow } from './api.js';
import { DecisionBadge } from './decisions.js';
import { ErrorBox } from './ErrorBox.js';

/** Bodies longer than this start with "hide equal" on. */
const LONG_BODY_LINES = 50;

/** Decision buttons for one side; absent when the Decisions cannot change (an Approval). */
export interface SideActions {
  busy: boolean;
  /** Opens the Discard or Move prompt for this one Message. */
  onPrompt(kind: 'discard' | 'move', handle: number): void;
  onDecide(decision: Decision, handle: number): void;
}

export function ComparisonView({
  source,
  id,
  handles: [a, b],
  rows,
  actions,
  onClose,
}: {
  /** Whose route reads the comparison: the Checkout's owner or an approver of the waiting Checkout. */
  source: 'checkout' | 'approval';
  /** The Checkout's id. */
  id: string;
  handles: readonly [number, number];
  /** The Checkout's Message rows, for each side's current Decision. */
  rows: MessageRow[];
  actions?: SideActions;
  onClose(): void;
}) {
  const [comparison, setComparison] = useState<MessageComparison>();
  const [error, setError] = useState<ApiError>();
  const [hideEqual, setHideEqual] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (source === 'checkout' ? api.compare(id, a, b) : api.approvalCompare(id, a, b))
      .then((c) => {
        if (cancelled) return;
        setComparison(c);
        setHideEqual(lineCount(c.left) > LONG_BODY_LINES || lineCount(c.right) > LONG_BODY_LINES);
      })
      .catch((err) => !cancelled && setError(err));
    return () => {
      cancelled = true;
    };
  }, [source, id, a, b]);

  const close = <button onClick={onClose}>Close comparison</button>;
  if (!comparison) {
    return (
      <section className="comparison">
        {error ? <ErrorBox error={error} /> : <p className="empty">Comparing…</p>}
        {close}
      </section>
    );
  }
  const { left, right, diff } = comparison;
  const shown = (fields: FieldDiff[]) => (hideEqual ? fields.filter((f) => f.status !== 'equal') : fields);

  return (
    <section className="comparison" aria-label="Comparison of two Messages">
      <div className="comparison-head">
        <h3>Comparing two Messages</h3>
        <label className="checkbox">
          <input type="checkbox" checked={hideEqual} onChange={(e) => setHideEqual(e.target.checked)} />
          Hide equal
        </label>
        {close}
      </div>
      <div className="comparison-sides">
        {[left, right].map((m) => (
          <Side key={m.handle} message={m} row={rows.find((r) => r.handle === m.handle)} actions={actions} />
        ))}
      </div>

      <FieldTable title="Properties" fields={shown(diff.properties)} />
      <FieldTable title="Headers" fields={shown(diff.headers)} />
      {diff.xDeath.length > 0 && (
        <>
          <h4>Dead-letter history (x-death, most recent first)</h4>
          {diff.xDeath
            .filter((x) => !hideEqual || x.status !== 'equal')
            .map((x) => (
              <FieldTable key={x.position} title={`Entry ${x.position + 1}`} fields={shown(x.fields)} level={5} />
            ))}
        </>
      )}
      {diff.failureDetails && <FieldTable title="Failure details" fields={shown(diff.failureDetails)} />}

      <h4>
        Body <small>{bodySummary(diff.body)}</small>
      </h4>
      <BodyComparison diff={diff.body} left={left} right={right} hideEqual={hideEqual} />
    </section>
  );
}

function Side({ message: m, row, actions }: { message: MessageDetail; row?: MessageRow; actions?: SideActions }) {
  return (
    <div className="comparison-side">
      <strong>{m.messageId ?? 'Message without message_id'}</strong>{' '}
      {row && <DecisionBadge decision={row.decision} />}
      {actions && (
        <span className="comparison-decisions">
          <button className="danger" disabled={actions.busy} onClick={() => actions.onPrompt('discard', m.handle)}>
            Discard…
          </button>
          <button
            disabled={actions.busy || row?.replay.available === false}
            title={row?.replay.available === false ? row.replay.reason : 'Send back to the queue that dead-lettered it'}
            onClick={() => actions.onDecide({ kind: 'replay' }, m.handle)}
          >
            Replay
          </button>
          <button disabled={actions.busy} onClick={() => actions.onPrompt('move', m.handle)}>
            Move…
          </button>
          <button disabled={actions.busy} onClick={() => actions.onDecide({ kind: 'keep' }, m.handle)}>
            Keep
          </button>
        </span>
      )}
    </div>
  );
}

function FieldTable({ title, fields, level = 4 }: { title: string; fields: FieldDiff[]; level?: 4 | 5 }) {
  const Heading = level === 4 ? 'h4' : 'h5';
  return (
    <>
      <Heading>{title}</Heading>
      {fields.length === 0 ? (
        <p className="muted">No differences.</p>
      ) : (
        <table className="queues comparison-fields">
          <tbody>
            {fields.map((f) => (
              <tr key={f.name} className={`diff-${f.status}`}>
                <th>{f.name}</th>
                <td>{'left' in f ? <Value value={f.left} /> : <span className="muted">not set</span>}</td>
                <td>{'right' in f ? <Value value={f.right} /> : <span className="muted">not set</span>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </>
  );
}

function Value({ value }: { value: unknown }) {
  return <code>{typeof value === 'string' ? value : JSON.stringify(value)}</code>;
}

function BodyComparison({
  diff,
  left,
  right,
  hideEqual,
}: {
  diff: BodyDiff;
  left: MessageDetail;
  right: MessageDetail;
  hideEqual: boolean;
}) {
  switch (diff.kind) {
    case 'json':
      return (
        <>
          {diff.changes.length > 0 && (
            <table className="queues comparison-fields">
              <tbody>
                {diff.changes.map((c) => (
                  <tr key={c.path} className={`diff-${c.status}`}>
                    <th>
                      <code>{c.path}</code>
                    </th>
                    <td>{'left' in c ? <Value value={c.left} /> : <span className="muted">not set</span>}</td>
                    <td>{'right' in c ? <Value value={c.right} /> : <span className="muted">not set</span>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {!hideEqual && <WholeBodies left={left} right={right} />}
        </>
      );
    case 'text':
      return <TextRows left={bodyText(left)} right={bodyText(right)} hunks={diff.hunks} hideEqual={hideEqual} />;
    case 'binary':
    case 'mixed':
      return hideEqual ? null : <WholeBodies left={left} right={right} />;
  }
}

function WholeBodies({ left, right }: { left: MessageDetail; right: MessageDetail }) {
  return (
    <div className="comparison-sides">
      {[left, right].map((m) => (
        <pre key={m.handle} className={m.body.kind === 'binary' ? 'wrap' : undefined}>
          {m.body.kind === 'binary' ? m.body.hex : m.body.text}
        </pre>
      ))}
    </div>
  );
}

/** Text lines aligned side by side: equal lines plain (left out when hidden), each hunk highlighted. */
function TextRows({ left, right, hunks, hideEqual }: { left: string[]; right: string[]; hunks: TextHunk[]; hideEqual: boolean }) {
  const rows: Array<{ key: string; status: 'equal' | 'changed'; left: string | null; right: string | null }> = [];
  let l = 0;
  let r = 0;
  const equalUntil = (leftEnd: number) => {
    for (; l < leftEnd; l++, r++) if (!hideEqual) rows.push({ key: `e${l}`, status: 'equal', left: left[l]!, right: right[r]! });
  };
  for (const h of hunks) {
    equalUntil(h.leftStart - 1);
    for (let i = 0; i < Math.max(h.leftLines.length, h.rightLines.length); i++) {
      rows.push({ key: `h${h.leftStart}-${h.rightStart}-${i}`, status: 'changed', left: h.leftLines[i] ?? null, right: h.rightLines[i] ?? null });
    }
    l += h.leftLines.length;
    r += h.rightLines.length;
  }
  equalUntil(left.length);
  return (
    <table className="comparison-text">
      <tbody>
        {rows.map((row) => (
          <tr key={row.key} className={`diff-${row.status}`}>
            <td>
              <pre>{row.left ?? ''}</pre>
            </td>
            <td>
              <pre>{row.right ?? ''}</pre>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function bodyText(m: MessageDetail): string[] {
  return m.body.kind === 'binary' ? [] : m.body.text.split('\n');
}

function lineCount(m: MessageDetail): number {
  return bodyText(m).length;
}

function bodySummary(d: BodyDiff): string {
  if (d.kind === 'mixed') return `(bodies of different kinds: ${d.leftKind} and ${d.rightKind})`;
  if (d.equal) return `(${d.kind}, equal)`;
  switch (d.kind) {
    case 'json':
      return `(JSON, ${d.changes.length} change${d.changes.length === 1 ? '' : 's'})`;
    case 'text':
      return `(text, ${d.hunks.length} changed run${d.hunks.length === 1 ? '' : 's'} of lines)`;
    case 'binary':
      return `(binary, ${d.leftSize} and ${d.rightSize} bytes, first difference at byte ${d.firstDifferentByte})`;
  }
}
