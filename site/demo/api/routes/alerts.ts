// Alerts, from the recording.
//
//   GET /alerts → { alerts, notifications, destinations }
import type { AlertsOverview } from '../../../../src/shared/alerts.js';
import { json, type Router } from '../router.js';
import type { DemoState } from '../state.js';

export function registerAlertRoutes(router: Router, state: DemoState) {
  router.on('GET', '/alerts', () => json(state.alerts satisfies AlertsOverview));
}
