// Replay Rule routes (ADR 0011): the rules of a Broker Profile, and a pass on demand.
//
//   GET  /api/profiles/:profile/replay-rules            → { rules: ReplayRuleView[] }   (viewer+)
//   POST /api/profiles/:profile/replay-rules/:name/run  → { pass: RulePass }            (admin)
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
import type { ReplayRuleView, RulePass } from '../../shared/replay-rules.js';

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
}
