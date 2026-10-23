// Root of the Volverán web app: pick a Broker Profile and vhost (remembered
// in localStorage) and see its queues, dead-letter queues first; start a
// Checkout on one, which replaces the queue list until it is over.
import { useEffect, useState } from 'react';
import { product } from '../shared/product.js';
import { api, ApiError, signOut, type Profile, type Queue, type Session } from './api.js';
import { CheckoutView } from './CheckoutView.js';

const STORAGE_KEY = 'volveran.location';

function loadLocation(): { profile?: string; vhost?: string } {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}');
  } catch {
    return {};
  }
}

function saveLocation(location: { profile?: string; vhost?: string }) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(location));
  } catch {
    // storage unavailable: just don't remember
  }
}

function useDebounced<T>(value: T, ms: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setDebounced(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return debounced;
}

export function App() {
  const [session, setSession] = useState<Session>();
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [profileName, setProfileName] = useState<string>();
  const [vhosts, setVhosts] = useState<string[]>([]);
  const [vhost, setVhost] = useState<string>();
  const [queues, setQueues] = useState<Queue[]>();
  const [search, setSearch] = useState('');
  const [onlyDeadLetterQueues, setOnlyDeadLetterQueues] = useState(false);
  const [error, setError] = useState<ApiError>();
  const [loading, setLoading] = useState(false);
  const [refreshTick, setRefreshTick] = useState(0);
  const [checkoutId, setCheckoutId] = useState<string | null>(null);
  /** A start refused because other consumers read the queue, awaiting the Operator's override. */
  const [consumersWarning, setConsumersWarning] = useState<{ queue: string; error: ApiError }>();
  const debouncedSearch = useDebounced(search, 200);

  const profile = profiles.find((p) => p.name === profileName);

  // A Protected Profile shows in the browser tab too, so it is visible from other tabs.
  useEffect(() => {
    document.title = profile?.protected ? `PROTECTED ${profile.name} · ${product.name}` : product.name;
  }, [profile?.name, profile?.protected]);

  useEffect(() => {
    api
      .session()
      .then((s) => {
        setSession(s);
        setCheckoutId(s.checkoutId);
      })
      .catch(setError);
    api
      .profiles()
      .then((list) => {
        setProfiles(list);
        const remembered = loadLocation().profile;
        setProfileName(list.some((p) => p.name === remembered) ? remembered : list[0]?.name);
      })
      .catch(setError);
  }, []);

  useEffect(() => {
    if (!profileName) return;
    setVhosts([]);
    setVhost(undefined);
    setQueues(undefined);
    setError(undefined);
    let cancelled = false;
    api
      .vhosts(profileName)
      .then((list) => {
        if (cancelled) return;
        setVhosts(list);
        const remembered = loadLocation().vhost;
        setVhost(list.includes(remembered ?? '') ? remembered : list[0]);
      })
      .catch((err) => !cancelled && setError(err));
    return () => {
      cancelled = true;
    };
  }, [profileName]);

  useEffect(() => {
    if (!profileName || !vhost) return;
    saveLocation({ profile: profileName, vhost });
    let cancelled = false;
    setLoading(true);
    api
      .queues(profileName, vhost, { search: debouncedSearch, onlyDeadLetterQueues })
      .then((list) => {
        if (cancelled) return;
        setQueues(list);
        setError(undefined);
      })
      .catch((err) => {
        if (cancelled) return;
        setQueues(undefined);
        setError(err);
      })
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [profileName, vhost, debouncedSearch, onlyDeadLetterQueues, refreshTick]);

  const startCheckout = async (queue: string, overrideConsumers = false) => {
    if (!profileName || !vhost) return;
    setError(undefined);
    setConsumersWarning(undefined);
    try {
      setCheckoutId((await api.startCheckout(profileName, vhost, queue, { overrideConsumers })).id);
    } catch (err) {
      const apiError = err as ApiError;
      if (apiError.code === 'queue_has_consumers') setConsumersWarning({ queue, error: apiError });
      else setError(apiError);
    }
  };

  return (
    <div className={profile?.protected ? 'app protected' : 'app'}>
      <header className="topbar">
        <h1>{product.name}</h1>
        <label>
          Broker Profile
          <select
            className={profile?.protected ? 'protected-select' : undefined}
            value={profileName ?? ''}
            onChange={(e) => setProfileName(e.target.value)}
          >
            {profiles.map((p) => (
              <option key={p.name} value={p.name}>
                {p.name}
                {p.protected ? ' — PROTECTED' : ''}
              </option>
            ))}
          </select>
        </label>
        <label>
          Vhost
          <select value={vhost ?? ''} onChange={(e) => setVhost(e.target.value)} disabled={vhosts.length === 0}>
            {vhosts.map((v) => (
              <option key={v} value={v}>
                {v}
              </option>
            ))}
          </select>
        </label>
        {profile && (
          <span className="who">
            as broker user <strong>{profile.username}</strong>
          </span>
        )}
        {profile?.protected && <span className="badge protected-badge">Protected Profile</span>}
        {session?.mode === 'solo' && (
          <span className="who">
            Solo Mode · Operator <strong>{session.operator}</strong>
          </span>
        )}
        {session?.mode === 'team' && (
          <span className="who">
            Operator <strong title={session.operatorId}>{session.operator}</strong>{' '}
            <button type="button" onClick={() => void signOut()}>
              Sign out
            </button>
          </span>
        )}
      </header>

      <main>
        <div className="controls">
          <input
            type="search"
            placeholder="Search queues by name"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            aria-label="Search queues by name"
          />
          <label className="checkbox">
            <input
              type="checkbox"
              checked={onlyDeadLetterQueues}
              onChange={(e) => setOnlyDeadLetterQueues(e.target.checked)}
            />
            Only dead-letter queues
          </label>
          <button onClick={() => setRefreshTick((n) => n + 1)} disabled={loading}>
            Refresh
          </button>
        </div>

        {error && (
          <div className="error" role="alert">
            <strong>{errorTitle(error)}</strong>
            <p>{error.message}</p>
            <code>{error.code}</code>
          </div>
        )}

        {consumersWarning && !checkoutId && (
          <div className="warning" role="alert">
            <strong>
              {consumersWarning.error.details.consumers === 1
                ? '1 consumer is'
                : `${String(consumersWarning.error.details.consumers)} consumers are`}{' '}
              reading {consumersWarning.queue}
            </strong>
            <p>{consumersWarning.error.message}</p>
            <button onClick={() => startCheckout(consumersWarning.queue, true)}>Check out anyway</button>{' '}
            <button onClick={() => setConsumersWarning(undefined)}>Cancel</button>
          </div>
        )}

        {checkoutId ? (
          <CheckoutView
            id={checkoutId}
            onClose={() => {
              setCheckoutId(null);
              setRefreshTick((n) => n + 1);
            }}
          />
        ) : (
          queues && (
            <>
              {profile?.protected && (
                <p className="protected-banner" role="note">
                  <span className="badge protected-badge">Protected Profile</span> Queues of{' '}
                  <strong>{profile.name}</strong> · vhost {vhost}. Every Apply that changes where a Message ends up,
                  and every Restore, needs the queue name typed.
                </p>
              )}
              <QueueTable queues={queues} onCheckout={startCheckout} />
            </>
          )
        )}
      </main>
    </div>
  );
}

function errorTitle(error: ApiError): string {
  switch (error.code) {
    case 'authentication_failed':
      return 'The broker rejected the credentials';
    case 'broker_unreachable':
      return 'Cannot reach the broker';
    case 'tls_failed':
      return 'TLS connection failed';
    case 'not_management_user':
    case 'vhost_not_accessible':
      return 'Missing permissions';
    case 'password_not_set':
      return 'Password not configured';
    case 'checkout_in_progress':
      return 'Already checked out';
    case 'operator_has_checkout':
      return 'You already have a Checkout';
    case 'lock_not_permitted':
      return 'Missing permission for the Checkout lock';
    default:
      return 'Something went wrong';
  }
}

function QueueTable({ queues, onCheckout }: { queues: Queue[]; onCheckout(queue: string): void }) {
  if (queues.length === 0) return <p className="empty">No queues match.</p>;
  return (
    <table className="queues">
      <thead>
        <tr>
          <th>Queue</th>
          <th>Type</th>
          <th className="num" title="From management statistics, which lag the broker by a few seconds">
            Messages <small>(approx.)</small>
          </th>
          <th className="num">Consumers</th>
          <th>Checkout</th>
        </tr>
      </thead>
      <tbody>
        {queues.map((q) => (
          <tr key={q.name} className={q.deadLetterQueue ? 'match' : undefined}>
            <td className="name">
              {q.name} {q.deadLetterQueue && <span className="badge dlq">DLQ</span>}
              {q.deadLetteredFrom.length > 0 && (
                <span className="dlq-source">dead-lettered from {q.deadLetteredFrom.join(', ')}</span>
              )}
              {q.setupWarning && (
                <span className="setup-warning" role="note">
                  <span className="badge limit-warning">Drops Messages after {q.setupWarning.deliveryLimit} deliveries</span>
                  <small>{q.setupWarning.message}</small>
                </span>
              )}
            </td>
            <td>
              <span className={`badge type-${q.type}`}>{q.type}</span>
            </td>
            <td className="num">≈ {q.approximateMessages}</td>
            <td className="num">{q.consumers}</td>
            <td>
              {q.checkedOutBy ? (
                <span className="unavailable">
                  Checked out
                  <small>
                    by {q.checkedOutBy.operator} since {new Date(q.checkedOutBy.since).toLocaleTimeString()}
                  </small>
                </span>
              ) : q.checkout.available ? (
                <button onClick={() => onCheckout(q.name)}>Check out</button>
              ) : (
                <span className="unavailable" title={q.checkout.reason}>
                  Not available
                  <small>{q.checkout.reason}</small>
                </span>
              )}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
