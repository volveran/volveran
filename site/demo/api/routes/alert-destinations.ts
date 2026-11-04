// The test notification to an Alert Destination (src/server/routes/alert-destinations.ts):
//
//   POST /alert-destinations/{name}/test → { delivery }
//
// Nothing leaves the browser in the demo (the banner says so), so a
// destination the profiles file declares answers as delivered, on the first
// attempt, without any request; no HTTP status, as nothing answered.
import type { AlertDestinationType, NotificationDelivery } from '../../../../src/shared/alerts.js';
import { DemoApiError, json, type Router } from '../router.js';

/** The Alert Destinations of scripts/screenshots/profiles.yaml. */
const DESTINATIONS: ReadonlyMap<string, AlertDestinationType> = new Map([['ops-slack', 'webhook']]);

export function registerAlertDestinationRoutes(router: Router) {
  let deliveries = 0;
  router.on('POST', '/alert-destinations/{name}/test', ({ params }) => {
    const name = params.name!;
    const type = DESTINATIONS.get(name);
    if (!type) throw new DemoApiError(404, 'alert_destination_not_found', `The profiles file declares no Alert Destination named "${name}".`);
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
    return json({ delivery });
  });
}
