// Audit view: browse and search Audit Entries ("what happened to message
// X?") by Broker Profile, queue, message_id, action, Operator, replay id,
// Replay Rule and date, and Restore a Discarded Message to its source queue or another
// existing one.
// A Discard whose body retention evicted shows "body expired" and offers no
// Restore. Warns when the store of Discarded bodies is near its size limit.
// Restore needs the role `admin` on the entry's Broker Profile; below it the
// action is shown as unavailable.
import { useEffect, useState } from 'react';
import { showingNul } from '../shared/audit.js';
import { roleIncludes, type Role } from '../shared/roles.js';
import { api, ApiError, type AuditAction, type AuditEntry, type AuditSearch, type AuditStoreUsage, type Profile } from './api.js';

/** How a Canary's watch ended, as the Audit view says it. */
const CANARY_OUTCOMES: Record<NonNullable<AuditEntry['canaryOutcome']>, string> = {
  died_again: 'died again',
  not_dead_lettered: 'not dead-lettered',
  watch_cut_short: 'watch cut short',
  unwatched: 'unwatched',
  failed: 'failed',
};

const ACTION_LABELS: Record<AuditAction, string> = {
  discard: 'Discard',
  replay: 'Replay',
  move: 'Move',
  restore: 'Restore',
  export: 'Export',
  rule_pause: 'Rule paused',
  rule_resume: 'Rule resumed',
};

const EMPTY_SEARCH: AuditSearch = {
  profile: '',
  queue: '',
  messageId: '',
  action: '',
  operator: '',
  checkoutId: '',
  replayId: '',
  rule: '',
  from: '',
  to: '',
};

function formatBytes(bytes: number): string {
  const units = ['bytes', 'KiB', 'MiB', 'GiB', 'TiB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${unit === 0 ? value : value.toFixed(1)} ${units[unit]}`;
}

export function AuditView({
  profiles,
  roles,
  initialSearch,
}: {
  profiles: Profile[];
  roles: Record<string, Role>;
  /** Where a link (a history mark) opened the view. Remount with a `key` to search again. */
  initialSearch?: AuditSearch | null;
}) {
  const [form, setForm] = useState<AuditSearch>({ ...EMPTY_SEARCH, ...initialSearch });
  const [search, setSearch] = useState<AuditSearch>({ ...EMPTY_SEARCH, ...initialSearch });
  const [entries, setEntries] = useState<AuditEntry[]>();
  const [usage, setUsage] = useState<AuditStoreUsage>();
  const [error, setError] = useState<ApiError>();
  const [loading, setLoading] = useState(false);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    api
      .auditEntries(search)
      .then((list) => {
        if (cancelled) return;
        setEntries(list);
        setError(undefined);
      })
      .catch((err) => !cancelled && setError(err))
      .finally(() => !cancelled && setLoading(false));
    api
      .auditStore()
      .then((u) => !cancelled && setUsage(u))
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [search, tick]);

  const field = (key: keyof AuditSearch) => ({
    value: form[key] ?? '',
    onChange: (e: { target: { value: string } }) => setForm({ ...form, [key]: e.target.value }),
  });

  return (
    <div className="audit">
      {usage?.nearLimit && (
        <div className="warning" role="alert">
          <strong>The store of Discarded Messages is near its size limit</strong>
          <p>
            {formatBytes(usage.storedBodyBytes)} of {formatBytes(usage.maxBodyBytes)} used. The oldest Discarded bodies
            are evicted to stay within the limit, and an evicted Message can no longer be Restored. Raise
            VOLVERAN_BODY_RETENTION_MAX_BYTES to keep more.
          </p>
        </div>
      )}
      <form
        className="controls"
        onSubmit={(e) => {
          e.preventDefault();
          setSearch(form);
        }}
      >
        <select aria-label="Broker Profile" {...field('profile')}>
          <option value="">Any Broker Profile</option>
          {profiles.map((p) => (
            <option key={p.name} value={p.name}>
              {p.name}
            </option>
          ))}
        </select>
        <input type="search" placeholder="Queue" aria-label="Queue" {...field('queue')} />
        <input type="search" placeholder="message_id" aria-label="message_id" {...field('messageId')} />
        <select aria-label="Action" {...field('action')}>
          <option value="">Any action</option>
          {Object.entries(ACTION_LABELS).map(([value, label]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </select>
        <input type="search" placeholder="Operator" aria-label="Operator" {...field('operator')} />
        <input type="search" placeholder="Checkout id" aria-label="Checkout id" {...field('checkoutId')} />
        <input
          type="search"
          placeholder="Replay id (x-volveran-replay-id)"
          aria-label="Replay id"
          {...field('replayId')}
        />
        <input type="search" placeholder="Replay rule" aria-label="Replay rule" {...field('rule')} />
        <label>
          From <input type="date" {...field('from')} />
        </label>
        <label>
          To <input type="date" {...field('to')} />
        </label>
        <button type="submit" disabled={loading}>
          Search
        </button>
      </form>

      {usage && (
        <p className="notice">
          Discarded bodies are kept {usage.maxAgeDays} days, up to {formatBytes(usage.maxBodyBytes)} in total (
          {formatBytes(usage.storedBodyBytes)} used); Audit Entries are kept indefinitely.
        </p>
      )}

      {error && (
        <div className="error" role="alert">
          <strong>Cannot load Audit Entries</strong>
          <p>{error.message}</p>
          <code>{error.code}</code>
        </div>
      )}

      {entries && entries.length === 0 && <p className="empty">No Audit Entries match.</p>}
      {entries && entries.length > 0 && (
        <table className="queues audit-entries">
          <thead>
            <tr>
              <th>When</th>
              <th>Action</th>
              <th>message_id</th>
              <th>Queue</th>
              <th>Destination</th>
              <th>Operator</th>
              <th>Rule</th>
              <th>Outcome</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {entries.map((entry) => (
              <EntryRow
                key={entry.id}
                entry={entry}
                profile={profiles.find((p) => p.name === entry.profile)}
                mayRestore={roles[entry.profile] !== undefined && roleIncludes(roles[entry.profile]!, 'admin')}
                restored={entries.some((e) => e.restoreOf === entry.id && e.outcome !== 'failed')}
                onRestored={() => setTick((n) => n + 1)}
              />
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

function EntryRow({
  entry,
  profile,
  restored,
  mayRestore,
  onRestored,
}: {
  entry: AuditEntry;
  profile: Profile | undefined;
  /** Whether the Operator's Role on the entry's profile allows a Restore. */
  mayRestore: boolean;
  restored: boolean;
  onRestored: () => void;
}) {
  const [confirming, setConfirming] = useState(false);
  const [queue, setQueue] = useState(entry.queue);
  const [typed, setTyped] = useState('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; text: string }>();
  const discardDone = entry.action === 'discard' && entry.outcome !== 'failed' && entry.message !== null;
  const bodyExpired = discardDone && entry.bodyExpiredAt !== null;
  const restorable = discardDone && !bodyExpired && !restored;
  const target = queue.trim();
  const typeQueueName = profile?.protected === true;
  const typedOk = !typeQueueName || typed === target;
  // Set when the server refused with 409 outcome_uncertain: the Discard may or
  // may not have removed the Message, so a Restore may duplicate it. Accepting
  // that is a second, separate confirmation.
  const [uncertainWarning, setUncertainWarning] = useState<string>();

  const cancel = () => {
    setConfirming(false);
    setUncertainWarning(undefined);
    setTyped('');
  };

  const restore = async (confirmUncertain: boolean) => {
    setBusy(true);
    setResult(undefined);
    try {
      const done = await api.restore(entry.id, {
        ...(target !== entry.queue && { queue: target }),
        ...(confirmUncertain && { confirmUncertain }),
        ...(typeQueueName && { confirmQueueName: typed }),
      });
      setResult(
        done.outcome === 'done'
          ? { ok: true, text: `Restored to ${done.destination?.queue}` }
          : { ok: false, text: `Restore failed: ${done.outcomeReason}` },
      );
      cancel();
      onRestored();
    } catch (err) {
      if (err instanceof ApiError && err.code === 'outcome_uncertain' && !confirmUncertain) {
        setUncertainWarning(err.message);
      } else {
        setResult({ ok: false, text: (err as ApiError).message });
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <tr>
      <td title={entry.at}>{new Date(entry.at).toLocaleString()}</td>
      <td>
        {ACTION_LABELS[entry.action]}
        {entry.restoreOf !== null && <small className="muted"> of #{entry.restoreOf}</small>}
        {entry.reason && <small className="muted"> ({showingNul(entry.reason)})</small>}
        {entry.rate !== null && <small className="muted"> at {entry.rate} Messages/s</small>}
        {entry.canary && (
          <span className="badge canary-badge" title="Replayed alone before the rest of its Apply, and watched">
            Canary{entry.canaryOutcome ? `: ${CANARY_OUTCOMES[entry.canaryOutcome]}` : ''}
          </span>
        )}
        {entry.messageCount !== null && (
          <small className="muted" title={entry.filter ? `Filter: ${JSON.stringify(entry.filter)}` : undefined}>
            {' '}
            of {entry.messageCount} Message(s){entry.filter ? ', filtered' : ''}
          </small>
        )}
      </td>
      <td className="name">{entry.messageId === null ? <span className="muted">none</span> : showingNul(entry.messageId)}</td>
      <td className="name">
        <small className="muted">{showingNul(entry.profile)} · </small>
        {entry.vhost === '/' ? '' : `${showingNul(entry.vhost)} / `}
        {showingNul(entry.queue)}
      </td>
      <td className="name">
        {entry.destination ? showingNul(entry.destination.queue ?? `${entry.destination.exchange} ${entry.destination.routingKey}`) : ''}
        {entry.replayId && (
          <small className="muted" title="x-volveran-replay-id">
            {' '}
            replay id <code>{entry.replayId}</code>
          </small>
        )}
      </td>
      <td title={entry.operatorId}>
        {showingNul(entry.operatorName)}
        {entry.role && <small className="muted"> ({entry.role})</small>}
        <small className="muted"> as {showingNul(entry.brokerUser)}</small>
      </td>
      <td className="name" title={entry.rulePassId ? `Rule Pass ${entry.rulePassId}` : undefined}>
        {showingNul(entry.rule ?? '')}
      </td>
      <td title={entry.outcomeReason ?? undefined}>
        <span className={`badge outcome-${entry.outcome}`}>{entry.outcome}</span>
        {entry.outcomeReason && <small className="muted"> {showingNul(entry.outcomeReason)}</small>}
      </td>
      <td>
        {bodyExpired && (
          <span className="badge limit-warning" title={`Evicted by retention on ${entry.bodyExpiredAt}`}>
            body expired
          </span>
        )}
        {restorable && !mayRestore && (
          <span className="unavailable">
            Restore needs the role <code>admin</code>
          </span>
        )}
        {restorable && mayRestore && !confirming && <button onClick={() => setConfirming(true)}>Restore…</button>}
        {restorable && confirming && !uncertainWarning && (
          <span className="confirm" role="alertdialog" aria-label="Confirm Restore">
            Restore to queue{' '}
            <input aria-label="Restore to queue" value={queue} onChange={(e) => setQueue(e.target.value)} />
            {typeQueueName && (
              <label className="type-queue-name">
                <span>
                  {entry.profile} is a Protected Profile: type <code>{target}</code> to confirm
                </span>
                <input
                  value={typed}
                  onChange={(e) => setTyped(e.target.value)}
                  aria-label="Queue name"
                  spellCheck={false}
                  autoComplete="off"
                />
              </label>
            )}
            <button className="danger" disabled={busy || !target || !typedOk} onClick={() => restore(false)}>
              Confirm Restore
            </button>
            <button className="link" onClick={cancel}>
              Cancel
            </button>
          </span>
        )}
        {restorable && confirming && uncertainWarning && (
          <span className="confirm" role="alertdialog" aria-label="Confirm Restore despite a possible duplicate">
            <small className="error-text">{uncertainWarning} </small>
            <button className="danger" disabled={busy} onClick={() => restore(true)}>
              Restore anyway, accepting a possible duplicate
            </button>
            <button className="link" onClick={cancel}>
              Cancel
            </button>
          </span>
        )}
        {result && <small className={result.ok ? 'muted' : 'error-text'}>{result.text}</small>}
      </td>
    </tr>
  );
}
