// Alerts in the web app and API. Alert Rules are declared in the profiles file
// (ADR 0012), so these only show them.
//
//   GET /api/alerts                       → AlertsOverview
//   GET /api/profiles/:profile/alert-rules → { rules: AlertRuleView[] }
//
// `GET /api/alerts` shows the Alerts and notifications of the profiles where the
// Operator has a Role, and test notifications, which belong to no profile, to
// those who may send one: 403 `no_role` with no Role anywhere. An Alert Rule's
// destinations are names and types, never URLs or secrets.
import type { FastifyInstance } from 'fastify';
import { alertsOf, destinationView, type AlertReadings } from '../alerts/views.js';
import { operatorOf } from '../operator.js';
import type { ProfileAccessCheck } from '../profile-access.js';
import type { AlertRuleView, AlertsOverview } from '../../shared/alerts.js';

export function registerAlertRoutes(app: FastifyInstance, readings: AlertReadings, access: ProfileAccessCheck) {
  app.get('/api/alerts', async (req): Promise<AlertsOverview> => {
    const operator = operatorOf(req);
    access.assertSomeRole(operator);
    return {
      alerts: access.list(operator, 'see_profile').flatMap((p) => alertsOf(readings.alerts, p.name)),
      notifications: readings.notifications.recent(undefined, {
        profiles: access.auditScope(operator, 'see_profile'),
        tests: access.list(operator, 'send_test_notification').length > 0,
      }),
      destinations: readings.destinations.map(destinationView),
    };
  });

  app.get<{ Params: { profile: string } }>('/api/profiles/:profile/alert-rules', async (req): Promise<{ rules: AlertRuleView[] }> => {
    const { profile } = access.profile(operatorOf(req), 'see_profile', req.params.profile);
    const destinations = new Map(readings.destinations.map((d) => [d.name, destinationView(d)]));
    return {
      rules: profile.alerts.map(({ name, destinations: names, when, forMs, repeatEveryMs }) => ({
        name,
        // Startup refuses a rule naming an undeclared destination.
        destinations: names.map((d) => destinations.get(d)!),
        when: { ...when },
        forMs,
        repeatEveryMs,
      })),
    };
  });
}
