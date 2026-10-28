// The session, Broker Profiles and queue list as the API sends them
// (src/server/routes/session.ts, routes/profiles.ts). Types only, shared by
// the server and the web app.
import type { CheckoutHolder } from './checkout.js';

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
    }
) & {
  /** The Operator's active Checkout, if any. */
  checkoutId: string | null;
};

/** A Broker Profile as listed, without its password. */
export interface ProfileSummary {
  name: string;
  username: string;
  managementUrl: string;
  amqpUrl: string;
  passwordEnv: string;
  /** Whether the password variable is set; a profile without one cannot connect. */
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
);

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
