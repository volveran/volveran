// Broker Profile routes: the profiles, their vhosts, the queues of a vhost
// (the queue list) and where a Move can go.
//
//   GET /api/profiles                                          → { profiles }
//   GET /api/profiles/:profile/vhosts                          → { vhosts }
//   GET /api/profiles/:profile/vhosts/:vhost/queues            → { defaultQueueFilter, queues, setupWarningCounts }
//       ?search=&onlyDeadLetterQueues=true
//   GET /api/profiles/:profile/vhosts/:vhost/move-destinations → { queues, exchanges }
//   GET /api/profiles/:profile/vhosts/:vhost/dead-letter-map   → { nodes, edges, cycles }
import type { FastifyInstance } from 'fastify';
import { credentialsSummary } from '../broker-credentials.js';
import { operatorOf } from '../operator.js';
import type { ProfileAccessCheck } from '../profile-access.js';
import { isLockQueue } from '../triage/checkout-lock.js';
import { deadLetterMap } from '../triage/dead-letter-map.js';
import { compareNames, narrowQueues } from '../triage/queue-list.js';
import { readVhost } from '../triage/vhost-reading.js';
import type { DeadLetterMap } from '../../shared/dead-letter-map.js';
import type { MoveDestinations, ProfileSummary, QueueList } from '../../shared/queues.js';

export function registerProfileRoutes(app: FastifyInstance, access: ProfileAccessCheck) {
  app.get('/api/profiles', async (req): Promise<{ profiles: ProfileSummary[] }> => ({
    profiles: access.list(operatorOf(req), 'see_profile').map((p) => ({
      name: p.name,
      ...credentialsSummary(p),
      managementUrl: p.managementUrl,
      amqpUrl: p.amqpUrl,
      vhosts: p.vhosts,
      defaultQueueFilter: p.defaultQueueFilter ?? null,
      protected: p.protected,
    })),
  }));

  app.get<{ Params: { profile: string } }>('/api/profiles/:profile/vhosts', async (req) => {
    const { profile, management } = access.profile(operatorOf(req), 'see_profile', req.params.profile);
    const names = profile.vhosts === 'all' ? await management.listVhosts() : profile.vhosts;
    return { vhosts: names.map((name) => ({ name })) };
  });

  // Where a Move can go (the Decision bar's picker): the queues and the
  // exchanges of the vhost a client can publish to, by name. Volverán's own
  // lock queues, the default exchange and internal exchanges are left out.
  app.get<{ Params: { profile: string; vhost: string } }>('/api/profiles/:profile/vhosts/:vhost/move-destinations', async (req): Promise<MoveDestinations> => {
    const { vhost } = req.params;
    // For the Decision bar: only someone who may assign Decisions needs it.
    const { management } = access.vhost(operatorOf(req), 'checkout', req.params.profile, vhost);
    const [queues, exchanges] = await Promise.all([management.listQueues(vhost), management.listExchanges(vhost)]);
    return {
      queues: queues.map((q) => q.name).filter((name) => !isLockQueue(name)).sort(compareNames),
      exchanges: exchanges
        .filter((e) => !e.internal)
        .map(({ name, type }) => ({ name, type }))
        .sort((a, b) => compareNames(a.name, b.name)),
    };
  });

  app.get<{
    Params: { profile: string; vhost: string };
    Querystring: { search?: string; onlyDeadLetterQueues?: string };
  }>('/api/profiles/:profile/vhosts/:vhost/queues', async (req): Promise<QueueList> => {
    const { vhost } = req.params;
    const { profile, management } = access.vhost(operatorOf(req), 'see_profile', req.params.profile, vhost);
    const reading = await readVhost({ profile, management }, vhost);
    return {
      defaultQueueFilter: profile.defaultQueueFilter ?? null,
      queues: narrowQueues(reading.queues, { onlyDeadLetterQueues: req.query.onlyDeadLetterQueues === 'true', search: req.query.search }),
      setupWarningCounts: reading.setupWarningCounts,
    };
  });

  app.get<{ Params: { profile: string; vhost: string } }>('/api/profiles/:profile/vhosts/:vhost/dead-letter-map', async (req): Promise<DeadLetterMap> => {
    const { vhost } = req.params;
    const { profile, management } = access.vhost(operatorOf(req), 'see_profile', req.params.profile, vhost);
    return deadLetterMap(await readVhost({ profile, management }, vhost));
  });
}
