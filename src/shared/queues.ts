// The session, Broker Profiles and queue list as the API sends them
// (src/server/routes/session.ts, routes/profiles.ts). Types only, shared by
// the server and the web app.
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

/** A dead-letter set-up that silently loses Messages (src/server/triage/queue-list.ts). */
export interface SetupWarning {
  code: 'messages_dropped_at_delivery_limit';
  deliveryLimit: number;
  message: string;
}

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
  setupWarning: SetupWarning | null;
  /** Who holds the queue in a Checkout, from any Volverán instance; null when nobody does. */
  checkedOutBy: CheckoutHolder | null;
}

/** Where a Move can go in a vhost: its queues and the exchanges a client can publish to, by name. */
export interface MoveDestinations {
  queues: string[];
  exchanges: Array<{ name: string; type: string }>;
}
