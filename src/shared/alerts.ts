// Pure values shared by the server and the web app (no Node or DOM APIs).

export const ALERT_DESTINATION_TYPES = ['slack', 'teams', 'webhook'] as const;
export type AlertDestinationType = (typeof ALERT_DESTINATION_TYPES)[number];

export type NotificationStatus = 'firing' | 'resolved';
export type DeliveryOutcome = 'delivered' | 'failed';

/** The recorded outcome of one notification to one Alert Destination. Never holds the destination's URL. */
export interface NotificationDelivery {
  id: number;
  /** When the delivery ended. */
  at: string;
  alertId: string;
  destination: string;
  destinationType: AlertDestinationType;
  status: NotificationStatus;
  /** A test notification, not an Alert. */
  test: boolean;
  rule: string;
  profile: string | null;
  vhost: string | null;
  queue: string | null;
  outcome: DeliveryOutcome;
  /** The receiver's last HTTP status; null when it never answered. */
  httpStatus: number | null;
  /** Why it failed without an HTTP status: `timeout`, `server_stopping` or a network error code. */
  error: string | null;
  attempts: number;
}
