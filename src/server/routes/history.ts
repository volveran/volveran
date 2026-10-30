// A queue's depth history, read only from the audit store, never the broker.
//
//   GET /api/profiles/:profile/vhosts/:vhost/queues/:queue/history?from=&to=
//       → QueueHistory (default: the last 24 hours)
//
// Any Role on the profile may read it (the queue list's rule). A queue that no
// longer exists keeps its history until it ages out; one never sampled has an
// empty history. An `operatorToken` profile answers 409 `history_not_sampled`.
import type { FastifyInstance } from 'fastify';
import type { HistoryStore } from '../audit/history.js';
import { downsample } from '../history/downsample.js';
import { historyGaps } from '../history/gaps.js';
import { isSampled } from '../history/sampler.js';
import { HttpError, InvalidRequestError } from '../http-error.js';
import { operatorOf } from '../operator.js';
import type { ProfileAccessCheck } from '../profile-access.js';
import type { RuleClock } from '../replay-rules/rule-clock.js';
import type { HistoryMark, QueueHistory } from '../../shared/history.js';

/** The most points a history answers with. */
export const MAX_HISTORY_POINTS = 500;
const DAY_MS = 24 * 60 * 60 * 1000;

export interface HistoryRouteDeps {
  history: HistoryStore;
  clock: Pick<RuleClock, 'now'>;
  intervalMs: number;
}

function parseTime(name: string, value: string | undefined): Date | null {
  if (value === undefined || value.trim() === '') return null;
  const date = new Date(value.trim());
  if (Number.isNaN(date.getTime())) throw new InvalidRequestError(`"${name}" must be an ISO 8601 date-time, not "${value}".`);
  return date;
}

export function registerHistoryRoutes(app: FastifyInstance, { history, clock, intervalMs }: HistoryRouteDeps, access: ProfileAccessCheck) {
  app.get<{
    Params: { profile: string; vhost: string; queue: string };
    Querystring: { from?: string; to?: string };
  }>('/api/profiles/:profile/vhosts/:vhost/queues/:queue/history', async (req): Promise<QueueHistory> => {
    const { vhost, queue } = req.params;
    const { profile } = access.queue(operatorOf(req), 'see_profile', req.params.profile, vhost, queue);
    if (!isSampled(profile)) {
      throw new HttpError(
        409,
        'history_not_sampled',
        `Broker Profile "${profile.name}" connects with each Operator's own token, so it has no depth history: there is no credential to sample with when nobody is signed in.`,
      );
    }
    const now = clock.now();
    const to = parseTime('to', req.query.to) ?? now;
    const from = parseTime('from', req.query.from) ?? new Date(to.getTime() - DAY_MS);
    if (from > to) throw new InvalidRequestError('"from" must not be after "to".');

    const ref = { profile: profile.name, vhost, queue };
    const latest = history.latestSample(ref);
    const samples = downsample(history.samples(ref, from.getTime(), to.getTime()), MAX_HISTORY_POINTS);
    const gaps = historyGaps(history.runsAround(profile.name, from.getTime(), to.getTime()), {
      from: from.getTime(),
      to: to.getTime(),
      now: now.getTime(),
      intervalMs,
    });
    const marks = history.takeOuts(ref, from.getTime(), to.getTime()).map((t): HistoryMark => ({
      at: new Date(t.at).toISOString(),
      kind: t.rule === null ? 'apply' : 'rule_pass',
      operator: t.operator,
      rule: t.rule,
      checkoutId: t.checkoutId,
      counts: t.counts,
      auditUrl: `/api/audit-entries?${new URLSearchParams({ profile: profile.name, queue, checkoutId: t.checkoutId })}`,
    }));
    return {
      from: from.toISOString(),
      to: to.toISOString(),
      latestSampleAt: latest && new Date(latest.at).toISOString(),
      samples: samples.map((s) => ({ at: new Date(s.at).toISOString(), depth: s.depth, estimatedArrivals: s.estimatedArrivals })),
      gaps: gaps.map((g) => ({ from: new Date(g.from).toISOString(), to: new Date(g.to).toISOString(), errorCode: g.errorCode })),
      marks,
    };
  });
}
