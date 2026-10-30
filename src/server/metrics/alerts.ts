// The metrics of Alerts: how many fire now, read at each scrape from the audit
// store's Alerts (never a broker), and how notifications went, told by the
// notifier. Test notifications are not counted: an admin trying a new webhook
// says nothing about Alerts being delivered.
import type { AlertStore } from '../audit/alerts.js';
import type { BrokerProfile } from '../profiles.js';
import type { NotificationDelivery } from '../../shared/alerts.js';
import { MetricCounter, type MetricFamily } from './exposition.js';

export class AlertMetrics {
  private readonly notifications = new MetricCounter(
    'volveran_alert_notifications_total',
    'Notifications of Alerts since the process started, by Alert Destination and outcome. Test notifications are not counted.',
  );

  constructor(private readonly readings: { profiles: readonly BrokerProfile[]; store: Pick<AlertStore, 'load'> }) {}

  delivered({ test, destination, outcome }: NotificationDelivery): void {
    if (!test) this.notifications.inc({ destination, outcome });
  }

  families(): MetricFamily[] {
    const { profiles, store } = this.readings;
    return [
      {
        name: 'volveran_alerts_firing',
        help: 'Alerts of an Alert Rule firing now.',
        type: 'gauge',
        series: profiles.flatMap((p) => {
          const firing = store.load(p.name).alerts.filter((a) => a.status === 'firing');
          return p.alerts.map(({ name }) => ({
            labels: { profile: p.name, rule: name },
            value: firing.filter((a) => a.rule === name).length,
          }));
        }),
      },
      this.notifications.family(),
    ];
  }
}
