// Where a Canary is watched (pure, no I/O; docs/rabbitmq-behaviour.md,
// "Canary watch"). The Canary goes back to its source queue; if it fails
// again, that queue dead-letters it through its dead-letter exchange. A watch
// queue bound to that exchange with the bindings that route to the
// dead-letter queue receives a copy of it, and the dead-letter queue still
// gets its own, so nothing is consumed from it.
//
// Only direct, fanout and topic exchanges route by bindings Volverán can copy;
// for anything else (a headers exchange, no dead-letter exchange, a topology
// it could not read) the Canary is unwatched, with the reason.
//
// A Canary Replayed to a MassTransit input queue (ADR 0010) does not come
// back through broker dead-lettering: MassTransit publishes the fault to the
// `<input queue>_error` exchange, which routes it to the `_error` queue. The
// watch queue is bound there instead, with that exchange's bindings to the
// Checkout's queue.
import { effectiveDeadLetter, type CheckedQueue, type VhostTopology } from './setup-checks.js';

export type CanaryWatchBindings =
  | { watchable: true; exchange: string; routingKeys: string[] }
  | { watchable: false; reason: string };

const WATCH_QUEUE_PREFIX = 'volveran.canary.';

export function canaryQueueName(checkoutId: string): string {
  return WATCH_QUEUE_PREFIX + checkoutId;
}

export function isCanaryWatchQueue(name: string): boolean {
  return name.startsWith(WATCH_QUEUE_PREFIX);
}

const WATCHABLE_TYPES = new Set(['direct', 'fanout', 'topic']);

/**
 * How to bind a Canary's watch queue: `source` is the queue the Canary is
 * Replayed to (null when it could not be read), `deadLetterQueue` the
 * Checkout's queue. `massTransitInputQueue` is set when the Replay origin is
 * a MassTransit input queue rather than x-death.
 */
export function canaryWatchBindings(input: {
  source: Pick<CheckedQueue, 'name' | 'arguments' | 'effectivePolicy'> | null;
  massTransitInputQueue?: string;
  deadLetterQueue: string;
  topology: VhostTopology;
}): CanaryWatchBindings {
  const { source, deadLetterQueue, topology } = input;
  const unwatched = (why: string): CanaryWatchBindings => ({
    watchable: false,
    reason: `${why} The Canary's outcome will only say whether it was Replayed.`,
  });
  const boundTo = (exchange: string): CanaryWatchBindings => {
    const routingKeys = topology.bindings
      .filter((b) => b.source === exchange && b.destinationType === 'queue' && b.destination === deadLetterQueue)
      .map((b) => b.routingKey);
    if (routingKeys.length === 0) {
      return unwatched(`The exchange "${exchange}" has no binding to "${deadLetterQueue}" that a watch queue could copy.`);
    }
    return { watchable: true, exchange, routingKeys: [...new Set(routingKeys)] };
  };
  if (input.massTransitInputQueue !== undefined) {
    const errorExchange = `${input.massTransitInputQueue}_error`;
    const exchange = topology.exchanges.get(errorExchange);
    if (!exchange) {
      return unwatched(`MassTransit publishes the faults of "${input.massTransitInputQueue}" to the error exchange "${errorExchange}", which does not exist.`);
    }
    if (!WATCHABLE_TYPES.has(exchange.type)) {
      return unwatched(`The MassTransit error exchange "${errorExchange}" is a ${exchange.type} exchange; Volverán can only watch direct, fanout and topic exchanges.`);
    }
    return boundTo(errorExchange);
  }
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
  return boundTo(target.exchange);
}
