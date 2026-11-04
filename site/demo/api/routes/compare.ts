// Compare two Messages of a Checkout (src/server/routes/checkouts.ts, compareMessages):
//
//   GET /checkouts/{id}/compare?a=<handle>&b=<handle> → { left, right, diff }
import { DemoApiError, json, type Router } from '../router.js';
import { invalid } from '../simulator/audit-log.js';
import { diffMessages } from '../simulator/message-diff.js';
import type { DemoState } from '../state.js';

export function registerCompareRoutes(router: Router, state: DemoState) {
  const { checkouts } = state;
  router.on('GET', '/checkouts/{id}/compare', ({ params, query }) => {
    checkouts.get(params.id!);
    const a = query.get('a');
    const b = query.get('b');
    if (a === null || b === null) throw invalid('Name the two Messages to compare with "a" and "b".');
    const [left, right] = [handleOf(a), handleOf(b)];
    if (left === right) throw invalid('Compare two different Messages: "a" and "b" are the same handle.');
    const views = [checkouts.message(params.id!, left), checkouts.message(params.id!, right)] as const;
    return json({ left: views[0], right: views[1], diff: diffMessages(views[0], views[1]) });
  });
}

function handleOf(raw: string): number {
  const handle = Number(raw);
  if (raw === '' || !Number.isSafeInteger(handle)) throw new DemoApiError(404, 'message_not_found', `"${raw}" is not a Message handle.`);
  return handle;
}
