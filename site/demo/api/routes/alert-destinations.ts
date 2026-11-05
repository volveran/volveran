// The test notification to an Alert Destination (src/server/routes/alert-destinations.ts):
//
//   POST /alert-destinations/{name}/test → { delivery }
//
// Nothing leaves the browser in the demo (the banner says so), so a
// destination the profiles file declares answers as delivered, on the first
// attempt, without any request; no HTTP status, as nothing answered. It is
// recorded as the server records it: GET /alerts lists it first among the
// notifications, which keep the latest RECENT_LIMIT.
import { RECENT_LIMIT } from '../../../../src/server/audit/store-rows.js';
import type { NotificationDelivery } from '../../../../src/shared/alerts.js';
import { HttpError } from '../../../../src/server/http-error.js';
import { json, type Router } from '../router.js';
import type { DemoState } from '../state.js';

/** The destinations are those of the recording's GET /alerts (scripts/screenshots/profiles.yaml). */
export function registerAlertDestinationRoutes(router: Router, state: DemoState) {
  // Numbered after the recorded deliveries, as the server's store numbers them.
  let deliveries = Math.max(0, ...state.alerts.notifications.map((n) => n.id));
  router.on('POST', '/alert-destinations/{name}/test', ({ params }) => {
    const name = params.name!;
    const type = state.alerts.destinations.find((d) => d.name === name)?.type;
    if (!type) throw new HttpError(404, 'alert_destination_not_found', `The profiles file declares no Alert Destination named "${name}".`);
    const delivery: NotificationDelivery = {
      id: ++deliveries,
      at: new Date().toISOString(),
      alertId: `test-${crypto.randomUUID()}`,
      destination: name,
      destinationType: type,
      status: 'firing',
      test: true,
      rule: 'Test notification',
      profile: null,
      vhost: null,
      queue: null,
      replayRule: null,
      outcome: 'delivered',
      httpStatus: null,
      error: null,
      attempts: 1,
    };
    state.alerts.notifications = [delivery, ...state.alerts.notifications].slice(0, RECENT_LIMIT);
    return json({ delivery });
  });
}
