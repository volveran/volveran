// Audit Entries, from the simulator's audit store (src/server/routes/audit.ts):
//
//   GET /audit-entries?profile=&queue=&messageId=&action=&operator=&checkoutId=&replayId=&rule=&from=&to=&limit=
//       → { entries }, newest first, without Message bodies
//   GET /audit-entries/{id} → { entry } with the body (base64; null when none was kept)
//   GET /audit-store → BodyStoreUsage, against Volverán's default retention (the demo keeps every body for the page's life)
//   POST /audit-entries/{id}/restore { confirm, queue?, confirmQueueName? } → { entry } the Restore's own Audit Entry
import { bodyStoreUsage, DEFAULT_BODY_RETENTION } from '../../../../src/server/audit/body-retention.js';
import { DemoApiError, json, type Router } from '../router.js';
import { parseAuditSearch } from '../simulator/audit-log.js';
import { profileSettings } from '../simulator/profile-settings.js';
import { restore } from '../simulator/restore.js';
import type { DemoState } from '../state.js';

export function registerAuditRoutes(router: Router, state: DemoState) {
  router.on('GET', '/audit-entries', ({ query }) => json({ entries: state.audit.list(parseAuditSearch(query)) }));

  router.on('GET', '/audit-entries/{id}', ({ params }) => {
    const id = Number(params.id);
    const entry = Number.isSafeInteger(id) ? state.audit.get(id) : null;
    if (!entry) throw new DemoApiError(404, 'audit_entry_not_found', `No Audit Entry ${params.id}.`);
    return json({ entry });
  });

  router.on('GET', '/audit-store', () => json(bodyStoreUsage(state.audit.storedBodyBytes(), DEFAULT_BODY_RETENTION)));

  router.on('POST', '/audit-entries/{id}/restore', ({ params, body }) => {
    const id = Number(params.id);
    if (!Number.isSafeInteger(id)) throw new DemoApiError(404, 'audit_entry_not_found', `No Audit Entry ${params.id}.`);
    const deps = {
      audit: state.audit,
      broker: state.broker,
      operator: state.operator,
      profile: (name: string) => {
        const found = state.profiles.find((p) => p.summary.name === name);
        return found ? profileSettings(found.summary) : null;
      },
      hasVhost: (profile: string, vhost: string) => !!state.profiles.find((p) => p.summary.name === profile)?.vhosts.some((v) => v.name === vhost),
    };
    return json({ entry: restore(deps, id, body) });
  });
}
