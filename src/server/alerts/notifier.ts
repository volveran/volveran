// Delivers notifications to Alert Destinations: each one on its own, with a
// timeout and retries, its outcome recorded in the audit store. A delivery
// never waits for another, so callers need not wait for one either.
//
// `send` resolves with the outcome, delivered or failed, and rejects only for
// a destination the profiles file does not declare. Neither a destination's
// URL nor anything an Alert Destination answers is kept: failures record a status or an
// error code, because a network error's text can name the URL.
import { randomUUID } from 'node:crypto';
import { HttpError } from '../http-error.js';
import type { NotificationStore, NewNotificationDelivery } from '../audit/notifications.js';
import type { NotificationDelivery } from '../../shared/alerts.js';
import type { AlertDestination } from './destinations.js';
import { buildRequest, testNotification, type Notification } from './payloads.js';

export interface DeliveryTiming {
  /** How long one attempt may take. */
  timeoutMs: number;
  /** The wait before the second attempt; it doubles for each one after. */
  firstBackoffMs: number;
}

const DEFAULT_TIMING: DeliveryTiming = { timeoutMs: 5_000, firstBackoffMs: 1_000 };
const MAX_ATTEMPTS = 3;
const SERVER_STOPPING = 'server_stopping';

export interface NotifierOptions {
  destinations: AlertDestination[];
  store: NotificationStore;
  /** The base of the links in notifications; null: they carry none. */
  publicUrl: string | null;
  /** Called when an outcome could not be recorded. */
  onError?: (err: unknown) => void;
  /** Called with each delivery's outcome, recorded or not. */
  onDelivered?: (delivery: NotificationDelivery) => void;
  timing?: DeliveryTiming;
}

type AttemptResult = Pick<NewNotificationDelivery, 'outcome' | 'httpStatus' | 'error'>;

export function alertDestinationNotFound(name: string): HttpError {
  return new HttpError(404, 'alert_destination_not_found', `The profiles file declares no Alert Destination named "${name}".`);
}

export class Notifier {
  private readonly destinations: Map<string, AlertDestination>;
  private readonly timing: DeliveryTiming;
  private readonly stopping = new AbortController();
  private readonly inProgress = new Set<Promise<unknown>>();

  constructor(private readonly options: NotifierOptions) {
    this.destinations = new Map(options.destinations.map((d) => [d.name, d]));
    this.timing = options.timing ?? DEFAULT_TIMING;
  }

  /** Delivers `notification` to the named Alert Destination and records the outcome. */
  send(destinationName: string, notification: Notification): Promise<NotificationDelivery> {
    const destination = this.destinations.get(destinationName);
    if (!destination) return Promise.reject(alertDestinationNotFound(destinationName));
    const delivery = this.deliver(destination, notification);
    this.inProgress.add(delivery);
    void delivery.finally(() => this.inProgress.delete(delivery));
    return delivery;
  }

  /** Sends a clearly labelled test notification to the named Alert Destination. */
  sendTest(destinationName: string): Promise<NotificationDelivery> {
    return this.send(destinationName, testNotification(new Date(), `test-${randomUUID()}`));
  }

  /** Ends the deliveries in progress at once (each records `server_stopping`) and waits for them. Call before the audit store closes. */
  async close(): Promise<void> {
    this.stopping.abort();
    await Promise.allSettled(this.inProgress);
  }

  private async deliver(destination: AlertDestination, notification: Notification): Promise<NotificationDelivery> {
    let result: AttemptResult = { outcome: 'failed', httpStatus: null, error: SERVER_STOPPING };
    let attempts = 0;
    while (attempts < MAX_ATTEMPTS && !this.stopping.signal.aborted) {
      if (attempts > 0) await this.backOff(this.timing.firstBackoffMs * 2 ** (attempts - 1));
      if (this.stopping.signal.aborted) {
        result = { outcome: 'failed', httpStatus: result.httpStatus, error: SERVER_STOPPING };
        break;
      }
      attempts += 1;
      result = await this.attempt(destination, notification);
      if (result.outcome === 'delivered') break;
    }
    const delivery = this.record(destination, notification, result, attempts);
    this.options.onDelivered?.(delivery);
    return delivery;
  }

  private async attempt(destination: AlertDestination, notification: Notification): Promise<AttemptResult> {
    // Each attempt is built anew: a retried webhook carries a fresh timestamp and signature.
    const { headers, body } = buildRequest(destination, notification, this.options.publicUrl, new Date());
    const timeout = AbortSignal.timeout(this.timing.timeoutMs);
    try {
      const response = await fetch(destination.url, {
        method: 'POST',
        headers,
        body,
        // A redirect would hand the notification to an address nobody reviewed.
        redirect: 'manual',
        signal: AbortSignal.any([timeout, this.stopping.signal]),
      });
      await response.body?.cancel();
      return response.ok
        ? { outcome: 'delivered', httpStatus: response.status, error: null }
        : { outcome: 'failed', httpStatus: response.status, error: null };
    } catch (err) {
      return { outcome: 'failed', httpStatus: null, error: this.errorCode(err, timeout) };
    }
  }

  private errorCode(err: unknown, timeout: AbortSignal): string {
    if (this.stopping.signal.aborted) return SERVER_STOPPING;
    if (timeout.aborted) return 'timeout';
    const code = (err as { cause?: { code?: unknown } }).cause?.code;
    return typeof code === 'string' ? code : 'network_error';
  }

  private backOff(ms: number): Promise<void> {
    const { signal } = this.stopping;
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(timer);
        signal.removeEventListener('abort', done);
        resolve();
      };
      const timer = setTimeout(done, ms);
      signal.addEventListener('abort', done);
    });
  }

  private record(
    destination: AlertDestination,
    n: Notification,
    result: AttemptResult,
    attempts: number,
  ): NotificationDelivery {
    const entry: NewNotificationDelivery = {
      at: new Date(),
      alertId: n.alertId,
      destination: destination.name,
      destinationType: destination.type,
      status: n.status,
      test: n.test === true,
      rule: n.rule,
      profile: n.profile,
      vhost: n.vhost,
      queue: n.queue,
      replayRule: n.replayRule ?? null,
      ...result,
      attempts,
    };
    try {
      return this.options.store.record(entry);
    } catch (err) {
      // A delivery that happened stays reported, even if the store could not take its outcome.
      this.options.onError?.(err);
      return { ...entry, id: 0, at: entry.at.toISOString() };
    }
  }
}
