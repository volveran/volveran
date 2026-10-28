// Broker Profile routes: the profiles, their vhosts, the queues of a vhost
// (the queue list) and where a Move can go.
//
//   GET /api/profiles                                          → { profiles }
//   GET /api/profiles/:profile/vhosts                          → { vhosts }
//   GET /api/profiles/:profile/vhosts/:vhost/queues            → { defaultQueueFilter, queues, setupWarningCounts }
//       ?search=&onlyDeadLetterQueues=true
//   GET /api/profiles/:profile/vhosts/:vhost/move-destinations → { queues, exchanges }
import type { FastifyInstance } from 'fastify';
import { operatorOf } from '../operator.js';
import type { ProfileAccessCheck } from '../profile-access.js';
import { checkoutHolders, isLockQueue } from '../triage/checkout-lock.js';
import { arrangeQueues, checkoutAvailability, compareNames, deadLetterSources } from '../triage/queue-list.js';
import { countSetupWarnings, setupWarnings, type VhostTopology } from '../triage/setup-checks.js';
import type { MoveDestinations, ProfileSummary, QueueList, QueueRow } from '../../shared/queues.js';

export function registerProfileRoutes(app: FastifyInstance, access: ProfileAccessCheck) {
  app.get('/api/profiles', async (req): Promise<{ profiles: ProfileSummary[] }> => ({
    profiles: access.list(operatorOf(req), 'see_profile').map((p) => ({
      name: p.name,
      credentials: p.credentials.kind,
      username: p.credentials.kind === 'shared' ? p.credentials.username : null,
      managementUrl: p.managementUrl,
      amqpUrl: p.amqpUrl,
      passwordEnv: p.credentials.kind === 'shared' ? p.credentials.passwordEnv : null,
      passwordSet: p.credentials.kind === 'shared' && p.credentials.password !== undefined,
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

  // Depth and consumer counts come from management statistics, which lag the
  // broker by a few seconds: the list calls the depth approximate.
  app.get<{
    Params: { profile: string; vhost: string };
    Querystring: { search?: string; onlyDeadLetterQueues?: string };
  }>('/api/profiles/:profile/vhosts/:vhost/queues', async (req): Promise<QueueList> => {
    const { vhost } = req.params;
    const { profile, management } = access.vhost(operatorOf(req), 'see_profile', req.params.profile, vhost);
    const [allQueues, bindings, exchanges] = await Promise.all([
      management.listQueues(vhost),
      management.listBindings(vhost),
      management.listExchanges(vhost),
    ]);
    // Checkout lock queues are Volverán's own: not listed, but they say who holds which queue.
    const holders = checkoutHolders(allQueues);
    const queues = allQueues.filter((q) => !isLockQueue(q.name));
    const rows = queues.map((q) => ({
      name: q.name,
      type: q.type,
      approximateMessages: q.messages,
      consumers: q.consumers,
      checkout: checkoutAvailability(q.type),
      checkedOutBy: holders.get(q.name) ?? null,
    }));
    const arrangeOptions = { defaultQueueFilter: profile.defaultQueueFilter, deadLetterSources: deadLetterSources(queues, bindings) };

    // Set-up checks run on every queue of the vhost, so the counts do not
    // depend on the search or the dead-letter queue filter.
    const topology: VhostTopology = { exchanges: new Map(exchanges.map((e) => [e.name, e])), bindings };
    const warningsByName = new Map(
      arrangeQueues(queues, arrangeOptions).map((q) => [q.name, setupWarnings(q, topology)]),
    );

    const listed = arrangeQueues(rows, {
      ...arrangeOptions,
      onlyDeadLetterQueues: req.query.onlyDeadLetterQueues === 'true',
      search: req.query.search,
    });
    return {
      defaultQueueFilter: profile.defaultQueueFilter ?? null,
      queues: listed.map((row): QueueRow => ({ ...row, setupWarnings: warningsByName.get(row.name)! })),
      setupWarningCounts: countSetupWarnings(warningsByName.values()),
    };
  });
}
