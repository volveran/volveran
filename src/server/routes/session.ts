// Session route: who is acting. In Solo Mode the configured name, in Team
// Mode the signed-in person. `checkoutId` is the Operator's active
// Checkout, so the web app can return to it.
//
//   GET /api/session → { mode, operator, checkoutId, operatorId?, email?, name? }
import type { FastifyInstance } from 'fastify';
import type { CheckoutManager } from '../checkout/manager.js';
import { operatorOf } from '../operator.js';

export interface SessionRouteDeps {
  mode: 'solo' | 'team';
  checkouts: CheckoutManager;
}

export function registerSessionRoutes(app: FastifyInstance, { mode, checkouts }: SessionRouteDeps) {
  app.get('/api/session', async (req) => {
    const operator = operatorOf(req);
    const checkoutId = checkouts.activeFor(operator.id)?.id ?? null;
    if (mode === 'solo') return { mode: 'solo', operator: operator.displayName, checkoutId };
    return {
      mode: 'team',
      operator: operator.displayName,
      operatorId: operator.id,
      ...(operator.email !== undefined && { email: operator.email }),
      ...(operator.name !== undefined && { name: operator.name }),
      checkoutId,
    };
  });
}
