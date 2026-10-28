// The export route: downloads a Checkout's held Messages as NDJSON, one line
// per Message in queue order (the line format is in the README, "Exporting
// Messages"; checkout/export.ts).
//
//   POST /api/checkouts/:id/export  { filter?: FilterClause[] }  → 200 application/x-ndjson
//        Content-Disposition: attachment; filename="volveran-<profile>-<queue>-<time>.ndjson"
//
// Without `filter`, every held Message; with one, the Messages "Select all
// matching" would pick. Under /api/checkouts/:id, so only the Checkout's
// owner may export it (403 `not_checkout_owner`), with the capability
// `checkout`. 409 `checkout_not_active` on a Checkout that is over or lost.
// Writes one `export` Audit Entry; changes nothing on the broker.
import { Readable } from 'node:stream';
import type { FastifyInstance } from 'fastify';
import { InvalidRequestError } from '../http-error.js';
import { isRecord } from '../is-record.js';
import { parseFilter, type Filter } from '../triage/filters.js';
import { checkoutAccess, type CheckoutRouteDeps } from './checkouts.js';

export function registerExportRoutes(app: FastifyInstance, deps: CheckoutRouteDeps) {
  const { checkouts } = deps;
  app.post<{ Params: { id: string }; Body: unknown }>('/api/checkouts/:id/export', async (req, reply) => {
    checkoutAccess(deps, req, 'checkout');
    const body = req.body ?? {};
    if (!isRecord(body)) throw new InvalidRequestError('The request body must be a JSON object.');
    let filter: Filter | null = null;
    if (body.filter !== undefined && body.filter !== null) {
      const parsed = parseFilter(body.filter);
      if (!parsed.ok) throw new InvalidRequestError(parsed.error);
      filter = parsed.filter;
    }
    const { filename, count, lines } = checkouts.exportMessages(req.params.id, filter);
    return reply
      .header('content-type', 'application/x-ndjson; charset=utf-8')
      .header('content-disposition', `attachment; filename="${filename}"`)
      .header('x-volveran-message-count', String(count))
      .send(Readable.from(lines, { objectMode: false }));
  });
}
