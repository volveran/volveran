// The Message filter: conditions that must all hold (routing key, header,
// x-death reason, original queue, body text, JSON path, failure, Died Again). Submitting narrows
// the Message list; "Select all matching" lives with the list. `/` focuses
// the first condition's value (firstFieldRef).
import { useState, type Ref } from 'react';
import type { FilterClause } from './api.js';

type Kind = FilterClause['kind'];

const KINDS: Array<{ kind: Kind; label: string; placeholder: string }> = [
  { kind: 'routing-key', label: 'Routing key', placeholder: 'orders.* (* and ? are wildcards)' },
  { kind: 'header', label: 'Header', placeholder: 'equals value (empty = header present)' },
  { kind: 'x-death-reason', label: 'x-death reason', placeholder: 'rejected, expired, maxlen, delivery_limit' },
  { kind: 'original-queue', label: 'Original queue', placeholder: 'orders.work (wildcards allowed)' },
  { kind: 'body-text', label: 'Body text', placeholder: 'text in the body (any case)' },
  { kind: 'json-path', label: 'JSON path', placeholder: 'value (empty = path present)' },
  { kind: 'failure', label: 'Failure', placeholder: 'exception type or message (any case)' },
  // Takes no value: the Messages that came back after a Replay, Move or Restore.
  { kind: 'died-again', label: 'Died Again', placeholder: '' },
];

/** A clause being edited: every field as text, turned into a FilterClause on submit. */
interface Draft {
  kind: Kind;
  /** Header name or JSON path. */
  key: string;
  value: string;
}

function toClause(d: Draft): FilterClause | undefined {
  if (d.kind === 'died-again') return { kind: 'died-again' };
  const value = d.value;
  if (d.kind === 'header') return d.key.trim() ? { kind: 'header', name: d.key.trim(), ...(value ? { value } : {}) } : undefined;
  if (d.kind === 'json-path') return d.key.trim() ? { kind: 'json-path', path: d.key.trim(), ...(value ? { value } : {}) } : undefined;
  return value ? { kind: d.kind, value } : undefined;
}

export function FilterBar({
  active,
  busy,
  onFilter,
  onClear,
  firstFieldRef,
}: {
  active: boolean;
  busy: boolean;
  onFilter: (filter: FilterClause[]) => void;
  onClear: () => void;
  firstFieldRef?: Ref<HTMLInputElement>;
}) {
  const [drafts, setDrafts] = useState<Draft[]>([{ kind: 'routing-key', key: '', value: '' }]);
  const update = (i: number, patch: Partial<Draft>) =>
    setDrafts((ds) => ds.map((d, j) => (j === i ? { ...d, ...patch } : d)));
  const clauses = drafts.map(toClause).filter((c): c is FilterClause => c !== undefined);

  return (
    <form
      className="filter-bar"
      onSubmit={(e) => {
        e.preventDefault();
        if (clauses.length > 0) onFilter(clauses);
      }}
    >
      {drafts.map((d, i) => {
        const meta = KINDS.find((k) => k.kind === d.kind)!;
        return (
          <div className="filter-clause" key={i}>
            <select
              aria-label="Filter by"
              value={d.kind}
              onChange={(e) => update(i, { kind: e.target.value as Kind })}
            >
              {KINDS.map((k) => (
                <option key={k.kind} value={k.kind}>
                  {k.label}
                </option>
              ))}
            </select>
            {(d.kind === 'header' || d.kind === 'json-path') && (
              <input
                type="search"
                aria-label={d.kind === 'header' ? 'Header name' : 'JSON path'}
                placeholder={d.kind === 'header' ? 'header name' : '$.order.items[*].sku'}
                value={d.key}
                onChange={(e) => update(i, { key: e.target.value })}
              />
            )}
            {d.kind !== 'died-again' && (
              <input
                ref={i === 0 ? firstFieldRef : undefined}
                type="search"
                aria-label={`${meta.label} value`}
                placeholder={meta.placeholder}
                value={d.value}
                onChange={(e) => update(i, { value: e.target.value })}
              />
            )}
            {drafts.length > 1 && (
              <button
                type="button"
                className="link"
                aria-label="Remove condition"
                onClick={() => setDrafts((ds) => ds.filter((_, j) => j !== i))}
              >
                Remove
              </button>
            )}
          </div>
        );
      })}
      <div className="filter-actions">
        <button
          type="button"
          className="link"
          onClick={() => setDrafts((ds) => [...ds, { kind: 'routing-key', key: '', value: '' }])}
        >
          + Add condition
        </button>
        <button type="submit" disabled={busy || clauses.length === 0}>
          Filter
        </button>
        {active && (
          <button type="button" className="link" onClick={onClear}>
            Clear filter
          </button>
        )}
      </div>
    </form>
  );
}
