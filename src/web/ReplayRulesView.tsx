// Replay rules view: the Replay Rules the profiles file declares for one
// Broker Profile (ADR 0011), each with its declaration, whether it runs or is
// paused, its next scheduled pass and its last passes (scheduled or Run now:
// when, held, Replayed, Moved, used up, not due; skipped or failed and why),
// and Run now for an `admin`, which runs one Rule Pass and shows its counts.
// While someone holds the queue, Run now is refused and says who. A paused
// rule says why (its automatic stop's reason in words, or the Operator's),
// by whom and since when. Pause, with a reason, is for an `operator` or
// above; Resume for an `admin`.
import { useEffect, useState } from 'react';
import { roleIncludes, type Role } from '../shared/roles.js';
import { durationText, pauseReasonText } from '../shared/replay-rules.js';
import { rateText } from '../shared/replay-rate.js';
import { time } from './time.js';
import { api, ApiError, type ReplayRuleView, type RulePass } from './api.js';

export function ReplayRulesView({ profile, role }: { profile: string; role: Role | undefined }) {
  const [rules, setRules] = useState<ReplayRuleView[]>();
  const [error, setError] = useState<ApiError>();
  const [tick, setTick] = useState(0);
  const mayRun = role !== undefined && roleIncludes(role, 'admin');
  const mayPause = role !== undefined && roleIncludes(role, 'operator');

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
        <RuleCard
          key={view.rule.name}
          profile={profile}
          view={view}
          mayRun={mayRun}
          mayPause={mayPause}
          onChanged={() => setTick((n) => n + 1)}
        />
      ))}
    </div>
  );
}

function RuleCard({
  profile,
  view,
  mayRun,
  mayPause,
  onChanged,
}: {
  profile: string;
  view: ReplayRuleView;
  mayRun: boolean;
  mayPause: boolean;
  onChanged: () => void;
}) {
  const { rule, state, passes, nextPassAt } = view;
  const [busy, setBusy] = useState<'run' | 'pause' | 'resume'>();
  const [error, setError] = useState<{ action: 'run' | 'pause' | 'resume'; error: ApiError }>();
  const [pausing, setPausing] = useState(false);
  const [reason, setReason] = useState('');

  const act = async (action: 'run' | 'pause' | 'resume') => {
    setBusy(action);
    setError(undefined);
    try {
      if (action === 'run') await api.runReplayRule(profile, rule.name);
      else if (action === 'pause') await api.pauseReplayRule(profile, rule.name, reason.trim());
      else await api.resumeReplayRule(profile, rule.name);
      setPausing(false);
      setReason('');
      onChanged();
    } catch (err) {
      setError({ action, error: err as ApiError });
    } finally {
      setBusy(undefined);
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
          {durationText(rule.everyMs)}, up to {rule.maxPerPass} Replays per pass {rateText(rule.rate)}
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
            {state.pausedReason && <>: {pauseReasonText(state.pausedReason)}</>}. No pass is scheduled.
          </>
        ) : (
          nextPassAt && <>Next pass {time(nextPassAt)}.</>
        )}
      </p>
      <PassHistory passes={passes} />
      <div className="rule-actions">
        {mayRun ? (
          <button onClick={() => act('run')} disabled={busy !== undefined}>
            {busy === 'run' ? 'Running…' : 'Run now'}
          </button>
        ) : (
          <span className="unavailable">
            Run now needs the role <code>admin</code>
          </span>
        )}
        {state.paused ? (
          mayRun ? (
            <button onClick={() => act('resume')} disabled={busy !== undefined}>
              {busy === 'resume' ? 'Resuming…' : 'Resume'}
            </button>
          ) : (
            <span className="unavailable">
              Resume needs the role <code>admin</code>
            </span>
          )
        ) : mayPause ? (
          !pausing && (
            <button onClick={() => setPausing(true)} disabled={busy !== undefined}>
              Pause…
            </button>
          )
        ) : (
          <span className="unavailable">
            Pause needs the role <code>operator</code>
          </span>
        )}
      </div>
      {pausing && !state.paused && (
        <form
          className="confirm"
          aria-label={`Pause Replay rule ${rule.name}`}
          onSubmit={(e) => {
            e.preventDefault();
            void act('pause');
          }}
        >
          <label>
            Why pause it?{' '}
            <input value={reason} onChange={(e) => setReason(e.target.value)} aria-label="Pause reason" required autoFocus />
          </label>{' '}
          <button type="submit" disabled={busy !== undefined || reason.trim() === ''}>
            {busy === 'pause' ? 'Pausing…' : 'Pause'}
          </button>{' '}
          <button type="button" onClick={() => setPausing(false)}>
            Cancel
          </button>
        </form>
      )}
      {error && (
        <div className="error" role="alert">
          <strong>
            {error.action === 'run'
              ? error.error.code === 'checkout_in_progress'
                ? 'The queue is held'
                : 'The pass did not run'
              : error.action === 'pause'
                ? 'The rule was not paused'
                : 'The rule was not resumed'}
          </strong>
          <p>{error.error.message}</p>
          <code>{error.error.code}</code>
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
          <th title="Due, but with nowhere to Replay to (no Replay origin); Kept">Cannot Replay</th>
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
                <td className="num">{p.summary.cannotReplay}</td>
                <td className={p.summary.failed > 0 ? 'num error-text' : 'num'}>{p.summary.failed}</td>
              </>
            ) : (
              <td colSpan={8} className={p.status === 'failed' ? 'error-text' : 'muted'}>
                {p.status === 'skipped' ? 'Skipped' : 'Failed'}: {p.reason}
              </td>
            )}
          </tr>
        ))}
      </tbody>
    </table>
  );
}
