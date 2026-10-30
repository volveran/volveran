// The session, Broker Profiles and queue list as the API sends them
// (src/server/routes/session.ts, routes/profiles.ts). Types only, shared by
// the server and the web app.
import type { DepthSeries } from './history.js';
import type { CheckoutHolder } from './checkout.js';
import type { Role } from './roles.js';

export type Session = (
  | {
      mode: 'solo';
      /** Who is acting: in Solo Mode, the configured name. */
      operator: string;
    }
  | {
      mode: 'team';
      /** Who is acting: the signed-in person's email, else name, else `sub`. */
      operator: string;
      /** The provider's `sub`. */
      operatorId: string;
      email?: string;
      name?: string;
      /** The groups Volverán read from the groups claim at sign-in. */
      groups: string[];
    }
) & {
  /** The Operator's active Checkout, if any. */
  checkoutId: string | null;
  /** The Operator's Role on each Broker Profile where they have one (always `admin` in Solo Mode). */
  roles: Record<string, Role>;
};

/** A Broker Profile as listed, without its password. */
export interface ProfileSummary {
  name: string;
  /** `shared`: one service account; `operatorToken`: each Operator's own access token (no username or password). */
  credentials: 'shared' | 'operatorToken';
  /** The shared broker user; null with `operatorToken`. */
  username: string | null;
  managementUrl: string;
  amqpUrl: string;
  /** The shared password's variable; null with `operatorToken`. */
  passwordEnv: string | null;
  /** Whether the password variable is set; a shared profile without one cannot connect. False with `operatorToken`. */
  passwordSet: boolean;
  vhosts: 'all' | string[];
  defaultQueueFilter: string | null;
  protected: boolean;
}

/**
 * How bad a set-up warning is: `loses_messages` when the broker drops
 * Messages as the queue is set up, `may_lose_messages` when it can lose them
 * (on a broker failure, say).
 */
export type SetupWarningSeverity = 'loses_messages' | 'may_lose_messages';

/**
 * A dead-letter set-up that silently loses Messages (src/server/triage/setup-checks.ts).
 * `message` says what is lost, why, and the change that fixes it.
 */
export type SetupWarning = { severity: SetupWarningSeverity; message: string } & (
  | { code: 'messages_dropped_at_delivery_limit'; deliveryLimit: number }
  | { code: 'dead_letter_exchange_missing'; deadLetterExchange: string }
  | { code: 'dead_letter_queue_drops_messages'; settings: DroppingSetting[] }
  | { code: 'quorum_at_most_once_dead_lettering' }
  /** routingKey is the dead-letter routing key, null when none is set (Messages keep their own). */
  | { code: 'dead_letter_unroutable'; deadLetterExchange: string; routingKey: string | null }
);

/** A dead-letter queue setting that drops Messages, by its policy key. */
export type DroppingSetting = 'message-ttl' | 'expires' | 'max-length' | 'max-length-bytes';

export type SetupWarningCode = SetupWarning['code'];

/** Set-up warnings of a whole vhost, by severity. */
export type SetupWarningCounts = Record<SetupWarningSeverity, number>;

export type CheckoutAvailability = { available: true } | { available: false; reason: string };

/** A row of the queue list. */
export interface QueueRow {
  name: string;
  type: string;
  /** From management statistics, which lag the broker by a few seconds. */
  approximateMessages: number;
  consumers: number;
  /** Matches the profile's queue-name filter, or other queues dead-letter into it. */
  deadLetterQueue: boolean;
  matchesDefaultFilter: boolean;
  /** The queues that dead-letter into it, by name. */
  deadLetteredFrom: string[];
  checkout: CheckoutAvailability;
  /** Every set-up warning that applies, most severe first; [] for none. */
  setupWarnings: SetupWarning[];
  /** Who holds the queue in a Checkout, from any Volverán instance; null when nobody does. */
  checkedOutBy: CheckoutHolder | null;
  /** The last 24 hours of depth. Only on the dead-letter queues of a sampled Broker Profile. */
  depthSeries?: DepthSeries;
}

/** The queue list of a vhost. */
export interface QueueList {
  defaultQueueFilter: string | null;
  queues: QueueRow[];
  /** Every queue of the vhost counts, whatever the search and dead-letter queue filter leave listed. */
  setupWarningCounts: SetupWarningCounts;
}

/** Where a Move can go in a vhost: its queues and the exchanges a client can publish to, by name. */
export interface MoveDestinations {
  queues: string[];
  exchanges: Array<{ name: string; type: string }>;
}
