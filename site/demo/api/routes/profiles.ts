// The Broker Profiles and what can be read of them, from the recording.
//
//   GET /profiles                                          → { profiles }
//   GET /profiles/{profile}/vhosts                         → { vhosts }
//   GET /profiles/{profile}/vhosts/{vhost}/queues?search=&onlyDeadLetterQueues=true → QueueList
//   GET /profiles/{profile}/vhosts/{vhost}/dead-letter-map → DeadLetterMap
//   GET /profiles/{profile}/vhosts/{vhost}/move-destinations → { queues, exchanges }
//   GET /profiles/{profile}/alert-rules                    → { rules }
//   GET /profiles/{profile}/replay-rules                   → { rules }
import type { ProfileSummary, QueueList, QueueRow } from '../../../../src/shared/queues.js';
import { json, type Router } from '../router.js';
import { withLiveQueues } from '../simulator/queue-overlay.js';
import { profileNamed, vhostOf, type DemoState } from '../state.js';

export function registerProfileRoutes(router: Router, state: DemoState) {
  router.on('GET', '/profiles', () => json({ profiles: state.profiles.map((p) => p.summary) satisfies ProfileSummary[] }));

  router.on('GET', '/profiles/{profile}/vhosts', ({ params }) =>
    json({ vhosts: profileNamed(state, params.profile!).vhosts.map(({ name }) => ({ name })) }),
  );

  // Answers from the vhost's queue list in the state, so what changes there (depths, Checkouts) shows here.
  router.on('GET', '/profiles/{profile}/vhosts/{vhost}/queues', ({ params, query }) => {
    const { queueList } = vhostOf(state, params.profile!, params.vhost!);
    const narrowed: QueueList = {
      ...queueList,
      queues: narrowQueues(withLiveQueues(queueList.queues, params.vhost!, state), {
        onlyDeadLetterQueues: query.get('onlyDeadLetterQueues') === 'true',
        search: query.get('search') ?? undefined,
      }),
    };
    return json(narrowed);
  });

  router.on('GET', '/profiles/{profile}/vhosts/{vhost}/dead-letter-map', ({ params }) => json(vhostOf(state, params.profile!, params.vhost!).deadLetterMap));

  router.on('GET', '/profiles/{profile}/vhosts/{vhost}/move-destinations', ({ params }) =>
    json(vhostOf(state, params.profile!, params.vhost!).moveDestinations),
  );

  router.on('GET', '/profiles/{profile}/alert-rules', ({ params }) => json({ rules: profileNamed(state, params.profile!).alertRules }));

  router.on('GET', '/profiles/{profile}/replay-rules', ({ params }) => json({ rules: profileNamed(state, params.profile!).replayRules }));
}

/** What the search and the dead-letter queue filter leave listed (src/server/triage/queue-list.ts). */
function narrowQueues(queues: QueueRow[], options: { onlyDeadLetterQueues: boolean; search: string | undefined }): QueueRow[] {
  const search = options.search?.trim().toLowerCase();
  return queues
    .filter((q) => !options.onlyDeadLetterQueues || q.deadLetterQueue)
    .filter((q) => !search || q.name.toLowerCase().includes(search));
}
