// Broker Profile routes: the profiles, their vhosts, the queues of a vhost
// (the queue list) and where a Move can go.
//
//   GET /api/profiles                                          → { profiles }
//   GET /api/profiles/:profile/vhosts                          → { vhosts }
//   GET /api/profiles/:profile/vhosts/:vhost/queues            → { defaultQueueFilter, queues }
//       ?search=&onlyDeadLetterQueues=true
//   GET /api/profiles/:profile/vhosts/:vhost/move-destinations → { queues, exchanges }
import type { FastifyInstance } from 'fastify';
import type { BrokerProfile } from '../profiles.js';
import { checkoutHolders, isLockQueue } from '../triage/checkout-lock.js';
import {
  arrangeQueues,
  checkoutAvailability,
  compareNames,
  deadLetterSetupWarning,
  deadLetterSources,
} from '../triage/queue-list.js';
import type { ProfileLookup } from './profile-lookup.js';

export interface ProfileRouteDeps {
  profiles: BrokerProfile[];
  lookup: ProfileLookup;
}

export function registerProfileRoutes(app: FastifyInstance, { profiles, lookup }: ProfileRouteDeps) {
  app.get('/api/profiles', async () => ({
    profiles: profiles.map((p) => ({
      name: p.name,
      username: p.username,
      managementUrl: p.managementUrl,
      amqpUrl: p.amqpUrl,
      passwordEnv: p.passwordEnv,
      passwordSet: p.password !== undefined,
      vhosts: p.vhosts,
      defaultQueueFilter: p.defaultQueueFilter ?? null,
      protected: p.protected,
    })),
  }));

  app.get<{ Params: { profile: string } }>('/api/profiles/:profile/vhosts', async (req) => {
    const { profile, management } = lookup.profile(req.params.profile);
    const names = profile.vhosts === 'all' ? await management.listVhosts() : profile.vhosts;
    return { vhosts: names.map((name) => ({ name })) };
  });

  // Where a Move can go (the Decision bar's picker): the queues and the
  // exchanges of the vhost a client can publish to, by name. Volverán's own
  // lock queues, the default exchange and internal exchanges are left out.
  app.get<{ Params: { profile: string; vhost: string } }>('/api/profiles/:profile/vhosts/:vhost/move-destinations', async (req) => {
    const { vhost } = req.params;
    const { management } = lookup.vhost(req.params.profile, vhost);
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
  }>('/api/profiles/:profile/vhosts/:vhost/queues', async (req) => {
    const { vhost } = req.params;
    const { profile, management } = lookup.vhost(req.params.profile, vhost);
    const [allQueues, bindings] = await Promise.all([management.listQueues(vhost), management.listBindings(vhost)]);
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
    const arranged = arrangeQueues(rows, {
      defaultQueueFilter: profile.defaultQueueFilter,
      deadLetterSources: deadLetterSources(queues, bindings),
      onlyDeadLetterQueues: req.query.onlyDeadLetterQueues === 'true',
      search: req.query.search,
    });
    const queueByName = new Map(queues.map((q) => [q.name, q]));
    return {
      defaultQueueFilter: profile.defaultQueueFilter ?? null,
      queues: arranged.map((row) => ({
        ...row,
        setupWarning: deadLetterSetupWarning({ ...queueByName.get(row.name)!, deadLetterQueue: row.deadLetterQueue }),
      })),
    };
  });
}
