// Replay Rule routes (ADR 0011): the rules of a Broker Profile, a pass on
// demand, and pause and resume.
//
//   GET  /api/profiles/:profile/replay-rules               → { rules: ReplayRuleView[] }   (viewer+)
//   POST /api/profiles/:profile/replay-rules/:name/run     → { pass: RulePass }            (admin)
//   POST /api/profiles/:profile/replay-rules/:name/pause   { reason } → { state: RuleState } (operator+)
//   POST /api/profiles/:profile/replay-rules/:name/resume  → { state: RuleState }          (admin)
//
// Pause needs a reason (400 `invalid_request` without one); pausing a paused
// rule answers 409 `replay_rule_paused`, resuming a running one 409
// `replay_rule_running`. Both are Audit Entries (`rule_pause`, `rule_resume`).
// Run now works on a paused rule too.
//
// Run now runs one Rule Pass and answers once it has ended, with its counts.
// It needs no Approval and no typed confirmation, even on a Protected
// Profile: the review of the profiles file is the second pair of eyes. 404
// `replay_rule_not_found` for a rule the profile does not declare; 409
// `checkout_in_progress` with the holder while someone holds the queue (the
// pass then touches nothing). The role check comes first, before anything
// else is looked up.
import type { FastifyInstance } from 'fastify';
import { operatorOf } from '../operator.js';
import type { ProfileAccessCheck } from '../profile-access.js';
import type { ReplayRules } from '../replay-rules/rules.js';
import type { ReplayRuleView, RulePass, RuleState } from '../../shared/replay-rules.js';

export function registerReplayRuleRoutes(app: FastifyInstance, rules: ReplayRules, access: ProfileAccessCheck) {
  app.get<{ Params: { profile: string } }>('/api/profiles/:profile/replay-rules', async (req): Promise<{ rules: ReplayRuleView[] }> => {
    const { profile } = access.profile(operatorOf(req), 'see_profile', req.params.profile);
    return { rules: rules.list(profile) };
  });

  app.post<{ Params: { profile: string; name: string } }>(
    '/api/profiles/:profile/replay-rules/:name/run',
    async (req): Promise<{ pass: RulePass }> => {
      const { profile } = access.profile(operatorOf(req), 'run_replay_rule', req.params.profile);
      return { pass: await rules.runNow(profile, req.params.name) };
    },
  );

  app.post<{ Params: { profile: string; name: string }; Body: { reason?: unknown } | undefined }>(
    '/api/profiles/:profile/replay-rules/:name/pause',
    async (req): Promise<{ state: RuleState }> => {
      const operator = operatorOf(req);
      const { profile, role } = access.profile(operator, 'pause_replay_rule', req.params.profile);
      return { state: rules.pause(profile, req.params.name, operator, role, req.body?.reason) };
    },
  );

  app.post<{ Params: { profile: string; name: string } }>(
    '/api/profiles/:profile/replay-rules/:name/resume',
    async (req): Promise<{ state: RuleState }> => {
      const operator = operatorOf(req);
      const { profile, role } = access.profile(operator, 'resume_replay_rule', req.params.profile);
      return { state: rules.resume(profile, req.params.name, operator, role) };
    },
  );
}
