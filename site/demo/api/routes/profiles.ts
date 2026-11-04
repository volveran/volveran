// The Broker Profiles and their vhosts, read-only (#148 serves them from recordings).
//
//   GET /profiles                    → { profiles }
//   GET /profiles/{profile}/vhosts   → { vhosts }
//   GET /profiles/{profile}/vhosts/{vhost}/queues?search=&onlyDeadLetterQueues=true → QueueList
import type { ProfileSummary, QueueList, QueueRow } from '../../../../src/shared/queues.js';
import { json, type Router } from '../router.js';
import { profileNamed, vhostOf, type DemoState } from '../state.js';

export function registerProfileRoutes(router: Router, state: DemoState) {
  router.on('GET', '/profiles', () => json({ profiles: state.profiles.map((p) => p.summary) satisfies ProfileSummary[] }));

  router.on('GET', '/profiles/{profile}/vhosts', ({ params }) =>
    json({ vhosts: profileNamed(state, params.profile!).vhosts.map(({ name }) => ({ name })) }),
  );

  router.on('GET', '/profiles/{profile}/vhosts/{vhost}/queues', ({ params, query }) => {
    const { queueList } = vhostOf(state, params.profile!, params.vhost!);
    const narrowed: QueueList = {
      ...queueList,
      queues: narrowQueues(queueList.queues, {
        onlyDeadLetterQueues: query.get('onlyDeadLetterQueues') === 'true',
        search: query.get('search') ?? undefined,
      }),
    };
    return json(narrowed);
  });
}

/** What the search and the dead-letter queue filter leave listed (src/server/triage/queue-list.ts). */
function narrowQueues(queues: QueueRow[], options: { onlyDeadLetterQueues: boolean; search: string | undefined }): QueueRow[] {
  const search = options.search?.trim().toLowerCase();
  return queues
    .filter((q) => !options.onlyDeadLetterQueues || q.deadLetterQueue)
    .filter((q) => !search || q.name.toLowerCase().includes(search));
}
