// Alerts view: what is firing or pending on the profiles the Operator has a Role
// on, the selected profile's Alert Rules (declared in the profiles file, ADR
// 0012), the recent notifications with whether each was delivered and why not,
// and a test notification to any Alert Destination for an `admin` on some profile.
// Alerts are not acknowledged or silenced here. An Alert about no queue (a Replay
// rule that paused itself, sampling that fails) says so, and has no history link.
import { useEffect, useState } from 'react';
import { alertPlaceText, alertReasonText, alertValueText, deliveryText, ruleConditionText, type AlertRuleView, type AlertsOverview, type NotificationDelivery } from '../shared/alerts.js';
import { historyPath } from '../shared/history-link.js';
import { durationText } from '../shared/replay-rules.js';
import { roleIncludes, type Role } from '../shared/roles.js';
import { time } from './time.js';
import { api, ApiError } from './api.js';

const Failure = ({ title, error }: { title: string; error: ApiError }) => (
  <div className="error" role="alert">
    <strong>{title}</strong>
    <p>{error.message}</p>
    <code>{error.code}</code>
  </div>
);

export function AlertsView({ profile, roles }: { profile: string | undefined; roles: Record<string, Role> }) {
  const [overview, setOverview] = useState<AlertsOverview>();
  const [rules, setRules] = useState<AlertRuleView[]>();
  const [error, setError] = useState<ApiError>();
  const [rulesError, setRulesError] = useState<ApiError>();
  const [tick, setTick] = useState(0);
  const mayTest = Object.values(roles).some((role) => roleIncludes(role, 'admin'));

  useEffect(() => {
    let cancelled = false;
    api
      .alerts()
      .then((next) => {
        if (cancelled) return;
        setOverview(next);
        setError(undefined);
      })
      .catch((err) => !cancelled && setError(err));
    return () => {
      cancelled = true;
    };
  }, [tick]);

  useEffect(() => {
    if (!profile) return;
    let cancelled = false;
    setRules(undefined);
    api
      .alertRules(profile)
      .then((next) => {
        if (cancelled) return;
        setRules(next);
        setRulesError(undefined);
      })
      .catch((err) => !cancelled && setRulesError(err));
    return () => {
      cancelled = true;
    };
  }, [profile, tick]);

  return (
    <div className="alerts">
      <div className="controls">
        <button type="button" onClick={() => setTick((n) => n + 1)}>
          Refresh
        </button>
      </div>
      {error && <Failure title="Cannot load the Alerts" error={error} />}

      <h2>Firing and pending</h2>
      {overview &&
        (overview.alerts.length === 0 ? (
          <p className="empty">Nothing is firing or pending on your Broker Profiles.</p>
        ) : (
          <table className="alert-list">
            <thead>
              <tr>
                <th>Status</th>
                <th>Alert Rule</th>
                <th>Broker Profile</th>
                <th>On</th>
                <th>Condition</th>
                <th>Value</th>
                <th>Why</th>
                <th>Since</th>
              </tr>
            </thead>
            <tbody>
              {overview.alerts.map((a) => (
                <tr key={a.alertId}>
                  <td>
                    <span className={`badge alert-${a.status}`}>{a.status}</span>
                  </td>
                  <td>{a.rule}</td>
                  <td>{a.profile}</td>
                  <td>
                    {a.vhost !== null && a.queue !== null ? (
                      <a href={historyPath({ profile: a.profile, vhost: a.vhost, queue: a.queue })}>{alertPlaceText(a)}</a>
                    ) : (
                      alertPlaceText(a)
                    )}
                  </td>
                  <td>
                    <code>{a.condition}</code>
                  </td>
                  <td>{alertValueText(a)}</td>
                  <td>{alertReasonText(a)}</td>
                  <td>{time(a.since)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ))}

      <h2>Alert Rules of {profile}</h2>
      <p className="notice">Alert Rules are declared in the profiles file, so a change to one goes through the same review as the rest of the configuration.</p>
      {rulesError && <Failure title="Cannot load the Alert Rules" error={rulesError} />}
      {rules &&
        (rules.length === 0 ? (
          <p className="empty">Broker Profile {profile} declares no Alert Rules.</p>
        ) : (
          <table className="alert-list">
            <thead>
              <tr>
                <th>Name</th>
                <th>Condition</th>
                <th>For</th>
                <th>Sent again</th>
                <th>Alert Destinations</th>
              </tr>
            </thead>
            <tbody>
              {rules.map((r) => (
                <tr key={r.name}>
                  <td>{r.name}</td>
                  <td>{ruleConditionText(r.when)}</td>
                  <td>{r.forMs > 0 ? durationText(r.forMs) : 'At once'}</td>
                  <td>{r.repeatEveryMs === null ? 'Never' : `Every ${durationText(r.repeatEveryMs)}`}</td>
                  <td>{r.destinations.map((d) => `${d.name} (${d.type})`).join(', ')}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ))}

      <h2>Alert Destinations</h2>
      {overview &&
        (overview.destinations.length === 0 ? (
          <p className="empty">The profiles file declares no Alert Destinations.</p>
        ) : (
          <ul className="alert-destinations">
            {overview.destinations.map((d) => (
              <TestableDestination key={d.name} name={d.name} type={d.type} mayTest={mayTest} onSent={() => setTick((n) => n + 1)} />
            ))}
          </ul>
        ))}

      <h2>Recent notifications</h2>
      {overview &&
        (overview.notifications.length === 0 ? (
          <p className="empty">No notifications yet.</p>
        ) : (
          <table className="alert-list">
            <thead>
              <tr>
                <th>When</th>
                <th>Alert Rule</th>
                <th>Broker Profile</th>
                <th>On</th>
                <th>Status</th>
                <th>Alert Destination</th>
                <th>Delivery</th>
              </tr>
            </thead>
            <tbody>
              {overview.notifications.map((n) => (
                <NotificationRow key={n.id} notification={n} />
              ))}
            </tbody>
          </table>
        ))}
    </div>
  );
}

function NotificationRow({ notification: n }: { notification: NotificationDelivery }) {
  return (
    <tr>
      <td>{time(n.at)}</td>
      <td>{n.rule}</td>
      <td>{n.profile ?? '—'}</td>
      <td>{n.test ? '—' : alertPlaceText(n)}</td>
      <td>{n.test ? 'test' : n.status}</td>
      <td>
        {n.destination} ({n.destinationType})
      </td>
      <td>
        <span className={`badge delivery-${n.outcome}`}>{deliveryText(n)}</span>
      </td>
    </tr>
  );
}

function TestableDestination({ name, type, mayTest, onSent }: { name: string; type: string; mayTest: boolean; onSent(): void }) {
  const [sending, setSending] = useState(false);
  const [outcome, setOutcome] = useState<string>();
  const [error, setError] = useState<ApiError>();
  // Reports its own errors, so handlers fire and forget it.
  const send = async () => {
    setSending(true);
    setOutcome(undefined);
    setError(undefined);
    try {
      setOutcome(deliveryText(await api.testAlertDestination(name)));
      onSent();
    } catch (err) {
      setError(err as ApiError);
    } finally {
      setSending(false);
    }
  };
  return (
    <li>
      <strong>{name}</strong> ({type}){' '}
      {mayTest ? (
        <button type="button" onClick={() => void send()} disabled={sending}>
          {sending ? 'Sending…' : 'Send test notification'}
        </button>
      ) : (
        <span className="unavailable">
          Sending a test notification needs the role <code>admin</code>
        </span>
      )}{' '}
      {outcome && <span role="status">{outcome}</span>}
      {error && <Failure title="Could not send the test notification" error={error} />}
    </li>
  );
}
