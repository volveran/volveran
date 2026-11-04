// The export route (src/server/routes/export.ts): a Checkout's held Messages
// as NDJSON, made in the browser. The web app turns the response into a
// download from its Content-Disposition, as it does with the server's.
//
//   POST /checkouts/{id}/export { filter?: FilterClause[] } → 200 application/x-ndjson
//        Content-Disposition: attachment; filename="volveran-<profile>-<queue>-<time>.ndjson"
import type { Filter } from '../../../../src/shared/filters.js';
import type { Router } from '../router.js';
import { invalid } from '../simulator/audit-log.js';
import { parseFilter } from '../simulator/filters.js';
import type { DemoState } from '../state.js';

export function registerExportRoutes(router: Router, state: DemoState) {
  router.on('POST', '/checkouts/{id}/export', ({ params, body }) => {
    state.checkouts.get(params.id!);
    const request = body ?? {};
    if (typeof request !== 'object' || request === null || Array.isArray(request)) throw invalid('The request body must be a JSON object.');
    const given = (request as { filter?: unknown }).filter;
    let filter: Filter | null = null;
    if (given !== undefined && given !== null) {
      const parsed = parseFilter(given);
      if (!parsed.ok) throw invalid(parsed.error);
      filter = parsed.filter;
    }
    const { filename, count, text } = state.checkouts.exportMessages(params.id!, filter);
    return new Response(text, {
      status: 200,
      headers: {
        'content-type': 'application/x-ndjson; charset=utf-8',
        'content-disposition': `attachment; filename="${filename}"`,
        'x-volveran-message-count': String(count),
      },
    });
  });
}
