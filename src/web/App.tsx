// Root of the Volverán web app: pick a Broker Profile and vhost (remembered
// in localStorage) and see its queues, dead-letter queues first; start a
// Checkout on one, which replaces the queue list until it is over. The Audit
// view (AuditView.tsx) browses Audit Entries and Restores Discarded Messages.
// The Replay rules view (ReplayRulesView.tsx) shows the selected profile's
// Replay Rules and runs a pass on demand.
// In Team Mode the Approvals view (ApprovalsView.tsx) lists other Operators'
// Applies waiting for an Approval this Operator may give; a requester's link
// (#/approvals/<checkout id>, approval-link.ts) opens it on their Checkout.
// Approvals stay reachable while the Operator has a Checkout of their own:
// that Checkout is hidden meanwhile, not ended, and comes back with Queues.
// An Operator with no role on any profile (Team Mode) gets a page saying so,
// listing the groups Volverán received (NoRolePage).
// Only the profiles where the Operator has a Role are listed (the server
// filters them), and actions their Role does not allow are shown as
// unavailable, naming the role they need.
// In the queue list j/k or the arrow keys move and Enter starts a Checkout
// (keys mapped in keyboard-commands.ts), and h opens a dead-letter queue's depth
// history (HistoryView.tsx), also reachable by link (#/history/..., history-link.ts).
// The Dead-letter Map view (DeadLetterMapView.tsx) follows the top bar's profile
// and vhost, by link too (#/dead-letter-map/...), so Back from a queue's history
// returns to it. A Checkout started there replaces it until the Checkout is over.
import { useEffect, useRef, useState } from 'react';
import { waitingCheckoutIn } from '../shared/approval-link.js';
import { auditSearchIn, deadLetterMapPath, deadLetterMapTargetIn, historyPath, historyTargetIn, type MapTarget } from '../shared/history-link.js';
import { product } from '../shared/product.js';
import { roleIncludes, type Role } from '../shared/roles.js';
import {
  api,
  ApiError,
  signOut,
  type Profile,
  type Queue,
  type QueueList,
  type Session,
  type SetupWarningCounts,
  type SetupWarningSeverity,
} from './api.js';
import { ApprovalsView } from './ApprovalsView.js';
import { AuditView } from './AuditView.js';
import { CheckoutView } from './CheckoutView.js';
import { DeadLetterMapView } from './DeadLetterMapView.js';
import { HistoryView, Sparkline } from './HistoryView.js';
import { ReplayRulesView } from './ReplayRulesView.js';
import { ShortcutList, useKeyboardCommands } from './keyboard.js';
import { CheckoutCell, SetupWarnings, severityLabel } from './queue-cells.js';
import { SignInAgain } from './SignInAgain.js';
import type { KeyboardCommand } from './keyboard-commands.js';

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
  const [queueList, setQueueList] = useState<QueueList>();
  const [search, setSearch] = useState('');
  const [onlyDeadLetterQueues, setOnlyDeadLetterQueues] = useState(false);
  const [error, setError] = useState<ApiError>();
  const [loading, setLoading] = useState(false);
  const [refreshTick, setRefreshTick] = useState(0);
  const [checkoutId, setCheckoutId] = useState<string | null>(null);
  /** The waiting Checkout a requester's link points at (the URL fragment), until it is left. */
  const [linkedApproval, setLinkedApproval] = useState(() => waitingCheckoutIn(window.location.hash));
  /** The queue whose history a link or the queue list opened. */
  const [historyTarget, setHistoryTarget] = useState(() => historyTargetIn(window.location.hash));
  /** The search a history mark's link opens the Audit view on, and which link it was, to search again. */
  const [auditLink, setAuditLink] = useState(() => ({ hash: window.location.hash, search: auditSearchIn(window.location.hash) }));
  const [mapTarget] = useState(() => deadLetterMapTargetIn(window.location.hash));
  const [view, setView] = useState<'queues' | 'audit' | 'approvals' | 'rules' | 'history' | 'map'>(() =>
    linkedApproval ? 'approvals' : historyTarget ? 'history' : mapTarget ? 'map' : auditLink.search ? 'audit' : 'queues',
  );
  /** Kept while the map is left for a queue's history, so Back finds it as it was. */
  const [mapSearch, setMapSearch] = useState('');
  /** A start refused because other consumers read the queue, awaiting the Operator's override. */
  const [consumersWarning, setConsumersWarning] = useState<{ queue: string; error: ApiError }>();
  const debouncedSearch = useDebounced(search, 200);
  /** The queue the keyboard is on. */
  const [focusedQueue, setFocusedQueue] = useState<string>();
  const [shortcutsOpen, setShortcutsOpen] = useState(false);

  const profile = profiles.find((p) => p.name === profileName);
  const role = profileName ? session?.roles[profileName] : undefined;
  /** Team Mode, signed in with no role on any Broker Profile: NoRolePage instead of the app. */
  const noRoleAnywhere = session?.mode === 'team' && Object.keys(session.roles).length === 0;

  /** The top bar follows a history link, so going back shows that queue's list. */
  const showProfileOf = ({ profile, vhost }: MapTarget) => {
    saveLocation({ profile, vhost });
    setProfileName(profile);
    setVhost(vhost);
  };

  /** Leaves whichever view a link opened: the fragment goes, so the same link works again. */
  const clearLink = () => window.history.replaceState(null, '', window.location.pathname + window.location.search);
  const switchView = (next: typeof view) => {
    clearLink();
    setAuditLink({ hash: '', search: null });
    setView(next);
  };

  // A link pasted into a tab already showing the app.
  useEffect(() => {
    const follow = () => {
      const { hash } = window.location;
      const linked = waitingCheckoutIn(hash);
      const history = historyTargetIn(hash);
      const map = deadLetterMapTargetIn(hash);
      const search = auditSearchIn(hash);
      if (linked) {
        setLinkedApproval(linked);
        setView('approvals');
      } else if (history) {
        showProfileOf(history);
        setHistoryTarget(history);
        setView('history');
      } else if (map) {
        showProfileOf(map);
        setView('map');
      } else if (search) {
        setAuditLink({ hash, search });
        setView('audit');
      } else {
        // The browser's Back, out of a history opened from the queue list.
        setView((current) => (current === 'history' ? 'queues' : current));
      }
    };
    window.addEventListener('hashchange', follow);
    return () => window.removeEventListener('hashchange', follow);
  }, []);

  // A Protected Profile shows in the browser tab too, so it is visible from other tabs.
  useEffect(() => {
    document.title = profile?.protected ? `PROTECTED ${profile.name} · ${product.name}` : product.name;
  }, [profile?.name, profile?.protected]);

  useEffect(() => {
    const linkedLocation = historyTarget ?? mapTarget;
    if (linkedLocation) saveLocation({ profile: linkedLocation.profile, vhost: linkedLocation.vhost });
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
    setQueueList(undefined);
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

  // The map's link names what the top bar shows, and its search starts over elsewhere.
  useEffect(() => {
    if (view === 'map' && profileName && vhost) window.history.replaceState(null, '', deadLetterMapPath({ profile: profileName, vhost }));
  }, [view, profileName, vhost]);
  useEffect(() => setMapSearch(''), [profileName, vhost]);

  const queueListShown = view !== 'map';
  useEffect(() => {
    if (!profileName || !vhost) return;
    saveLocation({ profile: profileName, vhost });
    if (!queueListShown) return;
    let cancelled = false;
    setLoading(true);
    api
      .queues(profileName, vhost, { search: debouncedSearch, onlyDeadLetterQueues })
      .then((list) => {
        if (cancelled) return;
        setQueueList(list);
        setError(undefined);
      })
      .catch((err) => {
        if (cancelled) return;
        setQueueList(undefined);
        setError(err);
      })
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [profileName, vhost, debouncedSearch, onlyDeadLetterQueues, refreshTick, queueListShown]);

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

  const queues = queueList?.queues ?? [];
  const run = (command: KeyboardCommand) => {
    switch (command.kind) {
      case 'move': {
        if (queues.length === 0) return;
        const at = queues.findIndex((q) => q.name === focusedQueue);
        setFocusedQueue(queues[at < 0 ? 0 : Math.max(0, Math.min(queues.length - 1, at + command.by))]!.name);
        return;
      }
      case 'start-checkout': {
        const q = queues.find((q) => q.name === focusedQueue);
        const mayCheckout = role !== undefined && roleIncludes(role, 'operator');
        if (q && mayCheckout && q.checkout.available && !q.checkedOutBy) void startCheckout(q.name);
        return;
      }
      case 'open-history': {
        const q = queues.find((q) => q.name === focusedQueue);
        if (q?.deadLetterQueue && profileName && vhost) window.location.hash = historyPath({ profile: profileName, vhost, queue: q.name }).slice(1);
        return;
      }
      case 'show-shortcuts':
        return setShortcutsOpen(true);
      case 'close-prompt':
        return setShortcutsOpen(false);
      default:
        return;
    }
  };
  useKeyboardCommands(
    view === 'queues' && !checkoutId && !noRoleAnywhere,
    {
      view: 'queue-list',
      prompt: shortcutsOpen,
      selection: 0,
      focusedItem: queues.some((q) => q.name === focusedQueue),
    },
    run,
  );

  /** Why a start from the queue list or the map did not go through. */
  const startProblems = (
    <>
      {error && (
        <div className="error" role="alert">
          <strong>{errorTitle(error)}</strong>
          <p>{error.message}</p>
          <code>{error.code}</code>
          <SignInAgain error={error} />
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
    </>
  );

  if (noRoleAnywhere) {
    return <NoRolePage operator={session.operator} operatorId={session.operatorId} groups={session.groups} />;
  }

  return (
    <div className={profile?.protected ? 'app protected' : 'app'}>
      <header className="topbar">
        <h1>{product.name}</h1>
        <nav className="view-switch" aria-label="View">
          <button type="button" aria-pressed={view === 'queues'} onClick={() => switchView('queues')}>
            Queues
          </button>
          <button type="button" aria-pressed={view === 'audit'} onClick={() => switchView('audit')}>
            Audit
          </button>
          <button type="button" aria-pressed={view === 'rules'} onClick={() => switchView('rules')}>
            Replay rules
          </button>
          <button type="button" aria-pressed={view === 'map'} onClick={() => switchView('map')}>
            Dead-letter Map
          </button>
          {session?.mode === 'team' && (
            <button type="button" aria-pressed={view === 'approvals'} onClick={() => switchView('approvals')}>
              Approvals
            </button>
          )}
        </nav>
        <label>
          Broker Profile
          <select
            className={profile?.protected ? 'protected-select' : undefined}
            value={profileName ?? ''}
            onChange={(e) => {
              if (view === 'history') switchView('queues');
              setProfileName(e.target.value);
            }}
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
          <select
            value={vhost ?? ''}
            onChange={(e) => {
              if (view === 'history') switchView('queues');
              setVhost(e.target.value);
            }}
            disabled={vhosts.length === 0}>
            {vhosts.map((v) => (
              <option key={v} value={v}>
                {v}
              </option>
            ))}
          </select>
        </label>
        {profile && (
          <span className="who">
            {profile.username !== null ? (
              <>
                as broker user <strong>{profile.username}</strong>
              </>
            ) : (
              'with your own broker token'
            )}
          </span>
        )}
        {profile?.protected && <span className="badge protected-badge">Protected Profile</span>}
        {session?.mode === 'team' && role && (
          <span className="who">
            role <code>{role}</code>
          </span>
        )}
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
        {view === 'approvals' && (
          <>
            {checkoutId && (
              <p className="notice" role="note">
                Your own Checkout stays open while you look at Approvals.{' '}
                <button type="button" onClick={() => setView('queues')}>
                  Back to your Checkout
                </button>
              </p>
            )}
            <ApprovalsView
              key={linkedApproval ?? ''}
              initialOpen={linkedApproval}
              onClosed={() => {
                setLinkedApproval(null);
                window.history.replaceState(null, '', window.location.pathname + window.location.search);
              }}
            />
          </>
        )}
        {view === 'audit' && !checkoutId ? (
          <AuditView key={auditLink.hash} initialSearch={auditLink.search} profiles={profiles} roles={session?.roles ?? {}} />
        ) : view === 'history' && historyTarget && !checkoutId ? (
          <HistoryView target={historyTarget} onBack={() => switchView('queues')} />
        ) : view === 'map' && !checkoutId ? (
          <>
            {startProblems}
            {profileName && vhost && (
              <DeadLetterMapView
                key={`${profileName}/${vhost}`}
                profile={profileName}
                vhost={vhost}
                role={role}
                search={mapSearch}
                onSearch={setMapSearch}
                onCheckout={(queue) => void startCheckout(queue)}
              />
            )}
          </>
        ) : view === 'rules' && !checkoutId ? (
          profileName && <ReplayRulesView profile={profileName} role={role} />
        ) : (
          // Hidden, not removed, under Approvals: the Operator's own Checkout keeps its heartbeat.
          <div hidden={view === 'approvals'}>
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

            {startProblems}

            {checkoutId ? (
              <CheckoutView
                id={checkoutId}
                hidden={view === 'approvals'}
                onClose={() => {
                  setCheckoutId(null);
                  setRefreshTick((n) => n + 1);
                }}
              />
            ) : (
              queueList && (
                <>
                  {profile?.protected && (
                    <p className="protected-banner" role="note">
                      <span className="badge protected-badge">Protected Profile</span> Queues of{' '}
                      <strong>{profile.name}</strong> · vhost {vhost}. Every Apply that changes where a Message ends up,
                      and every Restore, needs the queue name typed.
                    </p>
                  )}
                  <VhostWarningCounts counts={queueList.setupWarningCounts} vhost={vhost} />
                  <QueueTable
                    queues={queueList.queues}
                    profile={profileName}
                    vhost={vhost}
                    role={role}
                    focused={focusedQueue}
                    onFocus={setFocusedQueue}
                    onCheckout={startCheckout}
                  />
                  <p className="muted shortcut-hint">
                    Press <kbd>?</kbd> for keyboard shortcuts.
                  </p>
                </>
              )
            )}
          </div>
        )}
        {shortcutsOpen && <ShortcutList onClose={() => setShortcutsOpen(false)} />}
      </main>
    </div>
  );
}

/**
 * Team Mode, signed in with no role on any Broker Profile: say so, and list
 * the groups Volverán received, for the Operator to pass on to whoever
 * configures the profiles' `roles`.
 */
function NoRolePage({ operator, operatorId, groups }: { operator: string; operatorId: string; groups: string[] }) {
  return (
    <div className="app">
      <header className="topbar">
        <h1>{product.name}</h1>
        <span className="who">
          Operator <strong title={operatorId}>{operator}</strong>{' '}
          <button type="button" onClick={() => void signOut()}>
            Sign out
          </button>
        </span>
      </header>
      <main className="no-role">
        <h2>You have no role on any Broker Profile</h2>
        <p>
          Each Broker Profile gives a role to the groups listed in its <code>roles</code>, and none of your groups is
          listed in any of them. Ask whoever runs {product.name} to add one of your groups to the profiles you need.
        </p>
        {groups.length > 0 ? (
          <>
            <p>
              {product.name} received {groups.length === 1 ? 'this group' : `these ${groups.length} groups`} from your
              identity provider:
            </p>
            <ul className="groups">
              {groups.map((g) => (
                <li key={g}>
                  <code>{g}</code>
                </li>
              ))}
            </ul>
          </>
        ) : (
          <p>
            {product.name} received <strong>no groups</strong> from your identity provider. The provider may not send the
            groups claim {product.name} is configured to read, or you are in no group.
          </p>
        )}
        <p className="notice">
          Group changes apply the next time you sign in: sign out and in again once your access is fixed.
        </p>
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
    case 'broker_token_expired':
      return 'Sign in again';
    case 'checkout_in_progress':
      return 'Already checked out';
    case 'operator_has_checkout':
      return 'You already have a Checkout';
    case 'lock_not_permitted':
      return 'Missing permission for the Checkout lock';
    case 'no_role_on_profile':
      return 'No role on this Broker Profile';
    case 'role_required':
      return 'Your role does not allow this';
    default:
      return 'Something went wrong';
  }
}

/** The vhost's set-up warnings by severity, above the queue list (whatever the search leaves listed). */
function VhostWarningCounts({ counts, vhost }: { counts: SetupWarningCounts; vhost: string | undefined }) {
  const parts = (Object.keys(severityLabel) as SetupWarningSeverity[]).filter((s) => counts[s] > 0);
  if (parts.length === 0) return null;
  return (
    <p className="setup-warning-counts" role="status">
      Set-up warnings in vhost {vhost}:{' '}
      {parts.map((s) => (
        <span key={s} className={`badge severity-${s}`}>
          {severityLabel[s]}: {counts[s]}
        </span>
      ))}
    </p>
  );
}

/** The queue list. The keyboard's queue row takes the DOM focus, so it is visible and announced. */
function QueueTable({
  queues,
  profile,
  vhost,
  role,
  focused,
  onFocus,
  onCheckout,
}: {
  queues: Queue[];
  profile: string | undefined;
  vhost: string | undefined;
  role: Role | undefined;
  focused: string | undefined;
  onFocus(queue: string): void;
  onCheckout(queue: string): void;
}) {
  const rows = useRef(new Map<string, HTMLTableRowElement>());
  useEffect(() => {
    if (focused !== undefined) rows.current.get(focused)?.focus();
  }, [focused]);
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
          <th>Last 24 hours</th>
          <th>Checkout</th>
        </tr>
      </thead>
      <tbody>
        {queues.map((q) => (
          <tr
            key={q.name}
            ref={(row) => {
              if (row) rows.current.set(q.name, row);
              else rows.current.delete(q.name);
            }}
            tabIndex={-1}
            aria-current={q.name === focused ? 'true' : undefined}
            className={[q.deadLetterQueue && 'match', q.name === focused && 'focused'].filter(Boolean).join(' ') || undefined}
            onFocus={(e) => e.target === e.currentTarget && onFocus(q.name)}
          >
            <td className="name">
              {q.name} {q.deadLetterQueue && <span className="badge dlq">DLQ</span>}
              {q.deadLetteredFrom.length > 0 && (
                <span className="dlq-source">dead-lettered from {q.deadLetteredFrom.join(', ')}</span>
              )}
              <SetupWarnings warnings={q.setupWarnings} />
            </td>
            <td>
              <span className={`badge type-${q.type}`}>{q.type}</span>
            </td>
            <td className="num">≈ {q.approximateMessages}</td>
            <td className="num">{q.consumers}</td>
            <td>
              {q.deadLetterQueue && profile && vhost && (
                <a className="history-link" href={historyPath({ profile, vhost, queue: q.name })} aria-label={`Depth history of ${q.name}`}>
                  {q.depthSeries ? <Sparkline series={q.depthSeries} /> : 'History'}
                </a>
              )}
            </td>
            <td>
              <CheckoutCell queue={q.name} checkout={q.checkout} checkedOutBy={q.checkedOutBy} role={role} onCheckout={onCheckout} />
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
