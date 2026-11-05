// Pausing and resuming the recorded Replay rules, as src/server/routes/replay-rules.ts
// and replay-rules/rules.ts do it. The rules are listed by routes/profiles.ts
// from the same state, so a pause shows there. No Rule Pass is simulated, so
// Run now is left out of the demo.
//
//   POST /profiles/{profile}/replay-rules/{name}/pause  { reason } → { state }
//   POST /profiles/{profile}/replay-rules/{name}/resume            → { state }
//   POST /profiles/{profile}/replay-rules/{name}/run               → 404 not_in_demo
import { replayRuleNotFound, replayRulePaused, replayRuleRunning } from '../../../../src/server/replay-rules/errors.js';
import type { AuditAction } from '../../../../src/shared/audit.js';
import type { ReplayRuleView, RuleState } from '../../../../src/shared/replay-rules.js';
import { HttpError } from '../../../../src/server/http-error.js';
import { json, type Router } from '../router.js';
import { profileNamed, type DemoProfile, type DemoState } from '../state.js';

export function registerReplayRuleRoutes(router: Router, state: DemoState, now: () => number) {
  router.on('POST', '/profiles/{profile}/replay-rules/{name}/pause', ({ params, body }) => {
    const { profile, view } = ruleOf(state, params.profile!, params.name!);
    const reason = (body as { reason?: unknown } | undefined)?.reason;
    if (typeof reason !== 'string' || reason.trim() === '') throw new HttpError(400, 'invalid_request', '"reason" must say why the rule is paused.');
    if (view.state.paused) throw replayRulePaused(profile.summary.name, view.rule.name);
    const at = new Date(now()).toISOString();
    setState(view, { paused: true, pausedReason: reason.trim(), pausedBy: state.operator, pausedAt: at }, null);
    record(state, profile, view, 'rule_pause', reason.trim(), at);
    return json({ state: view.state });
  });

  router.on('POST', '/profiles/{profile}/replay-rules/{name}/resume', ({ params }) => {
    const { profile, view } = ruleOf(state, params.profile!, params.name!);
    if (!view.state.paused) throw replayRuleRunning(profile.summary.name, view.rule.name);
    const at = now();
    setState(view, { paused: false, pausedReason: null, pausedBy: null, pausedAt: null }, new Date(at + view.rule.everyMs).toISOString());
    record(state, profile, view, 'rule_resume', null, new Date(at).toISOString());
    return json({ state: view.state });
  });

  router.notInDemo(
    'POST',
    '/profiles/{profile}/replay-rules/{name}/run',
    'Not in the demo: it does not simulate Rule Passes. Pause and resume work; Run now needs Volverán against a broker.',
  );
}

function ruleOf(state: DemoState, profileName: string, name: string): { profile: DemoProfile; view: ReplayRuleView } {
  const profile = profileNamed(state, profileName);
  const view = profile.replayRules.find((r) => r.rule.name === name);
  if (!view) throw replayRuleNotFound(profileName, name);
  return { profile, view };
}

function setState(view: ReplayRuleView, ruleState: RuleState, nextPassAt: string | null) {
  view.state = ruleState;
  view.nextPassAt = nextPassAt;
}

/** The Audit Entry of a pause or resume: no Message, the rule named. */
function record(
  state: DemoState,
  profile: DemoProfile,
  { rule }: ReplayRuleView,
  action: Extract<AuditAction, 'rule_pause' | 'rule_resume'>,
  reason: string | null,
  at: string,
) {
  const id = state.audit.record({
    at,
    operatorId: state.operator,
    operatorName: state.operator,
    role: 'admin',
    approverId: null,
    approverName: null,
    brokerUser: profile.summary.username ?? '',
    profile: profile.summary.name,
    vhost: rule.vhost,
    queue: rule.queue,
    messageId: null,
    action,
    reason,
    destination: null,
    checkoutId: null,
    restoreOf: null,
    replayId: null,
    filter: null,
    messageCount: null,
    rate: null,
    rule: rule.name,
    rulePassId: null,
    canary: false,
    message: null,
  });
  state.audit.setOutcome(id, 'done');
}
