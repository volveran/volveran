// Replay rules view: the Replay Rules the profiles file declares for one
// Broker Profile (ADR 0011), each with its declaration, whether it runs or is
// paused, its next scheduled pass and its last passes (scheduled or Run now:
// when, held, Replayed, Moved, used up, not due; skipped or failed and why),
// and Run now for an `admin`, which runs one Rule Pass and shows its counts.
// While someone holds the queue, Run now is refused and says who.
import { useEffect, useState } from 'react';
import { roleIncludes, type Role } from '../shared/roles.js';
import { durationText } from '../shared/replay-rules.js';
import { rateText } from '../shared/replay-rate.js';
import { api, ApiError, type ReplayRuleView, type RulePass } from './api.js';

const time = (iso: string) => <span title={iso}>{new Date(iso).toLocaleString()}</span>;

export function ReplayRulesView({ profile, role }: { profile: string; role: Role | undefined }) {
  const [rules, setRules] = useState<ReplayRuleView[]>();
  const [error, setError] = useState<ApiError>();
  const [tick, setTick] = useState(0);
  const mayRun = role !== undefined && roleIncludes(role, 'admin');

  useEffect(() => {
    let cancelled = false;
    api
      .replayRules(profile)
      .then((list) => {
        if (cancelled) return;
        setRules(list);
        setError(undefined);
      })
      .catch((err) => !cancelled && setError(err));
    return () => {
      cancelled = true;
    };
  }, [profile, tick]);

  return (
    <div className="replay-rules">
      <p className="notice">
        Replay rules are declared in the profiles file of <strong>{profile}</strong>, so a change to one goes through the
        same review as the rest of the configuration. Each running rule passes on its own schedule: a Rule Pass takes a
        short Checkout as the rule, Replays the matching Messages that are due at the rule's rate, and Keeps the rest. A
        pass is skipped while someone holds the queue.
      </p>
      {error && (
        <div className="error" role="alert">
          <strong>Cannot load the Replay rules</strong>
          <p>{error.message}</p>
          <code>{error.code}</code>
        </div>
      )}
      {rules && rules.length === 0 && <p className="empty">Broker Profile {profile} declares no Replay rules.</p>}
      {rules?.map((view) => (
        <RuleCard key={view.rule.name} profile={profile} view={view} mayRun={mayRun} onRan={() => setTick((n) => n + 1)} />
      ))}
    </div>
  );
}

function RuleCard({
  profile,
  view,
  mayRun,
  onRan,
}: {
  profile: string;
  view: ReplayRuleView;
  mayRun: boolean;
  onRan: () => void;
}) {
  const { rule, state, passes, nextPassAt } = view;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError>();

  const run = async () => {
    setBusy(true);
    setError(undefined);
    try {
      await api.runReplayRule(profile, rule.name);
      onRan();
    } catch (err) {
      setError(err as ApiError);
    } finally {
      setBusy(false);
    }
  };

  const usedUp = rule.whenAttemptsUsedUp === 'keep' ? 'Keep them' : `Move them to ${rule.whenAttemptsUsedUp.moveTo.queue}`;
  return (
    <section className="replay-rule" aria-label={`Replay rule ${rule.name}`}>
      <h2>
        {rule.name}{' '}
        <small className="muted">
          {rule.vhost === '/' ? '' : `${rule.vhost} / `}
          {rule.queue}
        </small>
        {state.paused ? <span className="badge limit-warning">paused</span> : <span className="badge">running</span>}
      </h2>
      <dl className="rule-declaration">
        <dt>Messages</dt>
        <dd>{rule.filter ? <code>{JSON.stringify(rule.filter)}</code> : 'every Message'}</dd>
        <dt>Every</dt>
        <dd>
          {durationText(rule.everyMs)}, up to {rule.maxPerPass} Replays per pass at {rateText(rule.rate)}
        </dd>
        <dt>Back-off</dt>
        <dd>
          {durationText(rule.backoff.initialMs)} × {rule.backoff.multiplier}ⁿ, at most {durationText(rule.backoff.maxMs)}
        </dd>
        <dt>Attempts</dt>
        <dd>
          {rule.maxAttempts}, counted from Died Again; then {usedUp}
        </dd>
        <dt>Stops itself</dt>
        <dd>
          when {rule.stopWhen.diedAgain} of its Replayed Messages die again within {durationText(rule.stopWhen.withinMs)}
        </dd>
      </dl>
      <p className="next-pass">
        {state.paused ? (
          <>
            Paused{state.pausedAt && <> since {time(state.pausedAt)}</>}
            {state.pausedBy && <> by {state.pausedBy}</>}
            {state.pausedReason && <>: {state.pausedReason}</>}. No pass is scheduled.
          </>
        ) : (
          nextPassAt && <>Next pass {time(nextPassAt)}.</>
        )}
      </p>
      <PassHistory passes={passes} />
      {mayRun ? (
        <button onClick={run} disabled={busy}>
          {busy ? 'Running…' : 'Run now'}
        </button>
      ) : (
        <span className="unavailable">
          Run now needs the role <code>admin</code>
        </span>
      )}
      {error && (
        <div className="error" role="alert">
          <strong>{error.code === 'checkout_in_progress' ? 'The queue is held' : 'The pass did not run'}</strong>
          <p>{error.message}</p>
          <code>{error.code}</code>
        </div>
      )}
    </section>
  );
}

function PassHistory({ passes }: { passes: RulePass[] }) {
  if (passes.length === 0) return <p className="muted">No pass has run yet.</p>;
  return (
    <table className="pass-history">
      <caption>Last passes</caption>
      <thead>
        <tr>
          <th>When</th>
          <th>Held</th>
          <th>Replayed</th>
          <th>Moved</th>
          <th>Used up</th>
          <th>Not due</th>
          <th>Not matching</th>
          <th>Failed</th>
        </tr>
      </thead>
      <tbody>
        {passes.map((p) => (
          <tr key={p.id}>
            <td>{time(p.at)}</td>
            {p.summary ? (
              <>
                <td className="num">{p.summary.held}</td>
                <td className="num">{p.summary.replayed}</td>
                <td className="num">{p.summary.moved}</td>
                <td className="num">{p.summary.usedUp}</td>
                <td className="num">{p.summary.notDue}</td>
                <td className="num">{p.summary.noMatch}</td>
                <td className={p.summary.failed > 0 ? 'num error-text' : 'num'}>{p.summary.failed}</td>
              </>
            ) : (
              <td colSpan={7} className={p.status === 'failed' ? 'error-text' : 'muted'}>
                {p.status === 'skipped' ? 'Skipped' : 'Failed'}: {p.reason}
              </td>
            )}
          </tr>
        ))}
      </tbody>
    </table>
  );
}
