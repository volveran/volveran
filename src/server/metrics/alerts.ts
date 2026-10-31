// The metrics of Alerts: how many fire now, from the audit store's Alerts as
// last read in the background (store-readings.ts; never a broker), and how
// notifications went, told by the notifier. Test notifications are not counted:
// an admin trying a new webhook says nothing about Alerts being delivered.
import type { BrokerProfile } from '../profiles.js';
import type { NotificationDelivery } from '../../shared/alerts.js';
import { MetricCounter, type MetricFamily } from './exposition.js';

export class AlertMetrics {
  private readonly notifications = new MetricCounter(
    'volveran_alert_notifications_total',
    'Notifications of Alerts since the process started, by Alert Destination and outcome. Test notifications are not counted.',
  );

  constructor(
    private readonly readings: {
      profiles: readonly BrokerProfile[];
      /** The Alert Rule of each Alert of the profile firing, as last read; null until there is a reading. */
      firingRules(profile: string): readonly string[] | null;
    },
  ) {}

  delivered({ test, destination, outcome }: NotificationDelivery): void {
    if (!test) this.notifications.inc({ destination, outcome });
  }

  families(): MetricFamily[] {
    const { profiles, firingRules } = this.readings;
    return [
      {
        name: 'volveran_alerts_firing',
        help: 'Alerts of an Alert Rule firing now.',
        type: 'gauge',
        series: profiles.flatMap((p) => {
          const firing = firingRules(p.name);
          return p.alerts.map(({ name }) => ({
            labels: { profile: p.name, rule: name },
            value: firing && firing.filter((rule) => rule === name).length,
          }));
        }),
      },
      this.notifications.family(),
    ];
  }
}
