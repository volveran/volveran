// Alert Destinations (ADR 0012): declared in the profiles file, so the API only
// sends them a test notification.
//
//   POST /api/alert-destinations/:name/test → { delivery: NotificationDelivery }
//
// Needs `admin` on any Broker Profile (Team Mode; in Solo Mode the Operator
// is `admin`), checked before anything else: 403 `role_required`. 404
// `alert_destination_not_found` for a name the file does not declare. It
// answers 200 once the delivery has ended, delivered or failed; the outcome is
// in the body. A destination's URL never appears in a response.
import type { FastifyInstance } from 'fastify';
import type { Notifier } from '../alerts/notifier.js';
import { operatorOf } from '../operator.js';
import type { ProfileAccessCheck } from '../profile-access.js';
import type { NotificationDelivery } from '../../shared/alerts.js';

export function registerAlertDestinationRoutes(app: FastifyInstance, notifier: Notifier, access: ProfileAccessCheck) {
  app.post<{ Params: { name: string } }>(
    '/api/alert-destinations/:name/test',
    async (req): Promise<{ delivery: NotificationDelivery }> => {
      access.requireOnAnyProfile(operatorOf(req), 'send_test_notification');
      return { delivery: await notifier.sendTest(req.params.name) };
    },
  );
}
