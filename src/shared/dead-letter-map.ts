// The Dead-letter Map of a vhost as the API sends it
// (src/server/triage/dead-letter-map.ts, routes/profiles.ts). Types only,
// shared by the server and the web app.
import type { CheckoutHolder } from './checkout.js';
import type { CheckoutAvailability, SetupWarning } from './queues.js';

/** A queue that dead-letters or is dead-lettered into. `id` is `queue:<name>`. */
export interface DeadLetterMapQueue {
  id: string;
  kind: 'queue';
  name: string;
  type: string;
  /** From management statistics, which lag the broker by a few seconds. */
  approximateMessages: number;
  setupWarnings: SetupWarning[];
  /** Messages can come back to this queue: it is in one of `cycles`. */
  inCycle: boolean;
  /** As in the queue list: only these have a depth history. */
  deadLetterQueue: boolean;
  checkout: CheckoutAvailability;
  checkedOutBy: CheckoutHolder | null;
}

/** An exchange on a dead-letter path. `id` is `exchange:<name>`; "" is the default exchange. */
export interface DeadLetterMapExchange {
  id: string;
  kind: 'exchange';
  name: string;
  /** The exchange does not exist: a `drop` edge leaves it. */
  missing: boolean;
  /** On the way between the queues of one of `cycles`. */
  inCycle: boolean;
}

export type DeadLetterMapNode = DeadLetterMapQueue | DeadLetterMapExchange;

/** What every edge has. Node ids; `sources` are the queues whose dead-lettered Messages take this edge, by name. */
interface EdgeBase {
  from: string;
  sources: string[];
}

export type DeadLetterMapEdge = EdgeBase &
  (
    /** Queue to its dead-letter exchange. `routingKey` null: Messages keep their own routing key. */
    | { kind: 'dead_letter'; to: string; routingKey: string | null }
    /** Exchange to queue or exchange, through a binding with this key. */
    | { kind: 'binding'; to: string; bindingKey: string }
    /** Exchange to the alternate exchange that catches what it cannot route. */
    | { kind: 'alternate_exchange'; to: string }
    /** The default exchange to the queue the dead-letter routing key names. */
    | { kind: 'default_exchange'; to: string }
    /** A loss: the exchange is missing, or routes the routing key to no queue. */
    | { kind: 'drop'; reason: 'exchange_missing' | 'routes_nowhere' }
    /** Not a loss: where Messages go next cannot be told from the set-up. */
    | { kind: 'unresolved' }
    /** MassTransit's `<q>` to `<q>_error`: by the framework's convention, not by broker set-up. */
    | { kind: 'convention'; to: string }
  );

/** The graph of `GET /api/profiles/:profile/vhosts/:vhost/dead-letter-map`. */
export interface DeadLetterMap {
  /** By id. */
  nodes: DeadLetterMapNode[];
  edges: DeadLetterMapEdge[];
  /** Each cycle's node ids: the queues Messages can bounce between and the exchanges on the way. */
  cycles: string[][];
}
