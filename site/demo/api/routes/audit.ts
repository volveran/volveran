// Audit Entries, from the simulator's audit store (src/server/routes/audit.ts):
//
//   GET /audit-entries?profile=&queue=&messageId=&action=&operator=&checkoutId=&replayId=&rule=&from=&to=&limit=
//       → { entries }, newest first, without Message bodies
//   GET /audit-entries/{id} → { entry } with the body (base64; null when none was kept)
import { DemoApiError, json, type Router } from '../router.js';
import { parseAuditSearch } from '../simulator/audit-log.js';
import type { DemoState } from '../state.js';

export function registerAuditRoutes(router: Router, state: DemoState) {
  router.on('GET', '/audit-entries', ({ query }) => json({ entries: state.audit.list(parseAuditSearch(query)) }));

  router.on('GET', '/audit-entries/{id}', ({ params }) => {
    const id = Number(params.id);
    const entry = Number.isSafeInteger(id) ? state.audit.get(id) : null;
    if (!entry) throw new DemoApiError(404, 'audit_entry_not_found', `No Audit Entry ${params.id}.`);
    return json({ entry });
  });
}
