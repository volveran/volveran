// Alerts as the API shows them, read from the audit store, never a broker.
import type { AlertStore, NotificationStore } from '../audit/audit-store.js';
import type { AlertDestinationView, AlertView } from '../../shared/alerts.js';
import type { QueueRow } from '../../shared/queues.js';
import type { AlertDestination } from './destinations.js';

export interface AlertReadings {
  alerts: Pick<AlertStore, 'load'>;
  notifications: Pick<NotificationStore, 'recent'>;
  destinations: readonly AlertDestination[];
}

/** Only a name and a type: a destination's URL and secret never leave the server. */
export const destinationView = ({ name, type }: AlertDestination): AlertDestinationView => ({ name, type });

/** The profile's pending and firing Alerts, firing first. */
export async function alertsOf(store: Pick<AlertStore, 'load'>, profile: string): Promise<AlertView[]> {
  const views = (await store.load(profile)).alerts.map(
    ({ alertId, rule, vhost, queue, replayRule, reason, status, condition, value, threshold, since }): AlertView => ({
      alertId,
      profile,
      rule,
      vhost,
      queue,
      replayRule,
      reason,
      status,
      condition,
      value,
      threshold,
      since: new Date(since).toISOString(),
    }),
  );
  return [...views.filter((a) => a.status === 'firing'), ...views.filter((a) => a.status !== 'firing')];
}

/** Puts each queue's firing Alerts on its row. An Alert with no queue belongs to no row. */
export async function firingAlertsOn({ alerts }: Pick<AlertReadings, 'alerts'>, profile: string, vhost: string, queues: readonly QueueRow[]): Promise<QueueRow[]> {
  const firing = (await alertsOf(alerts, profile)).filter((a) => a.status === 'firing' && a.vhost === vhost);
  return queues.map((queue) => {
    const firingAlerts = firing.filter((a) => a.queue === queue.name);
    return queue.deadLetterQueue || firingAlerts.length > 0 ? { ...queue, firingAlerts } : queue;
  });
}
