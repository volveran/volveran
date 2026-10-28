// Session route: who is acting. In Solo Mode the configured name, in Team
// Mode the signed-in person. `checkoutId` is the Operator's active
// Checkout, so the web app can return to it. `roles` is the Operator's Role
// on each Broker Profile where they have one (profile-access.ts), and in
// Team Mode `groups` the groups read at sign-in.
//
//   GET /api/session → { mode, operator, checkoutId, roles, operatorId?, email?, name?, groups? }
import type { FastifyInstance } from 'fastify';
import type { CheckoutManager } from '../checkout/manager.js';
import { operatorOf } from '../operator.js';
import type { ProfileAccessCheck } from '../profile-access.js';
import type { RunMode } from '../run-mode.js';
import type { Session } from '../../shared/queues.js';

export interface SessionRouteDeps {
  mode: RunMode['kind'];
  checkouts: CheckoutManager;
  access: ProfileAccessCheck;
}

export function registerSessionRoutes(app: FastifyInstance, { mode, checkouts, access }: SessionRouteDeps) {
  app.get('/api/session', async (req): Promise<Session> => {
    const operator = operatorOf(req);
    const checkoutId = checkouts.activeFor(operator.id)?.id ?? null;
    const roles = access.roles(operator);
    if (mode === 'solo') return { mode: 'solo', operator: operator.displayName, checkoutId, roles };
    return {
      mode: 'team',
      operator: operator.displayName,
      operatorId: operator.id,
      ...(operator.email !== undefined && { email: operator.email }),
      ...(operator.name !== undefined && { name: operator.name }),
      checkoutId,
      roles,
      groups: operator.groups ?? [],
    };
  });
}
