// GET /session: Solo Mode, the Operator `demo`, admin on every Broker Profile.
import type { Session } from '../../../../src/shared/queues.js';
import { json, type Router } from '../router.js';
import type { DemoState } from '../state.js';

export function registerSessionRoutes(router: Router, state: DemoState) {
  router.on('GET', '/session', () =>
    json({
      mode: 'solo',
      operator: state.operator,
      checkoutId: state.checkoutId,
      roles: Object.fromEntries(state.profiles.map((p) => [p.summary.name, 'admin'])),
    } satisfies Session),
  );
}
