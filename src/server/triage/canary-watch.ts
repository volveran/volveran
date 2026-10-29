// Where a Canary is watched (pure, no I/O; docs/rabbitmq-behaviour.md,
// "Canary watch"). The Canary goes back to its source queue; if it fails
// again, that queue dead-letters it through its dead-letter exchange. A watch
// queue bound to that exchange with the bindings that route to the
// dead-letter queue receives a copy of it, and the dead-letter queue still
// gets its own, so nothing is consumed from it.
//
// Only direct, fanout and topic exchanges route by bindings Volverán can copy;
// for anything else (a headers exchange, no dead-letter exchange, a topology
// it could not read) the Canary is unwatched, with the reason. To watch
// somewhere else (e.g. a framework's error exchange), add a case here that
// returns the exchange and keys to bind.
import { effectiveDeadLetter, type CheckedQueue, type VhostTopology } from './setup-checks.js';

export type CanaryWatchBindings =
  | { watchable: true; exchange: string; routingKeys: string[] }
  | { watchable: false; reason: string };

const WATCHABLE_TYPES = new Set(['direct', 'fanout', 'topic']);

/**
 * How to bind a Canary's watch queue: `source` is the queue the Canary is
 * Replayed to (null when it could not be read), `deadLetterQueue` the
 * Checkout's queue.
 */
export function canaryWatchBindings(input: {
  source: Pick<CheckedQueue, 'name' | 'arguments' | 'effectivePolicy'> | null;
  deadLetterQueue: string;
  topology: VhostTopology;
}): CanaryWatchBindings {
  const { source, deadLetterQueue, topology } = input;
  const unwatched = (why: string): CanaryWatchBindings => ({
    watchable: false,
    reason: `${why} The Canary's outcome will only say whether it was Replayed.`,
  });
  if (!source) return unwatched('Where the queue the Canary goes back to dead-letters is not known.');
  const target = effectiveDeadLetter(source);
  if (!target) return unwatched(`"${source.name}" has no dead-letter exchange, so a Canary that fails again is not dead-lettered anywhere Volverán can watch.`);
  if (target.exchange === '') {
    return unwatched(`"${source.name}" dead-letters through the default exchange, which a watch queue cannot be bound to.`);
  }
  const exchange = topology.exchanges.get(target.exchange);
  if (!exchange) return unwatched(`"${source.name}" dead-letters to the exchange "${target.exchange}", which does not exist.`);
  if (!WATCHABLE_TYPES.has(exchange.type)) {
    return unwatched(
      `"${source.name}" dead-letters to the ${exchange.type} exchange "${target.exchange}"; Volverán can only watch direct, fanout and topic dead-letter exchanges.`,
    );
  }
  const routingKeys = topology.bindings
    .filter((b) => b.source === target.exchange && b.destinationType === 'queue' && b.destination === deadLetterQueue)
    .map((b) => b.routingKey);
  if (routingKeys.length === 0) {
    return unwatched(`The dead-letter exchange "${target.exchange}" has no binding to "${deadLetterQueue}" that a watch queue could copy.`);
  }
  return { watchable: true, exchange: target.exchange, routingKeys: [...new Set(routingKeys)] };
}
