// Pure: the estimated arrivals of a Sample. The broker does not count
// dead-lettered Messages in `message_stats.publish` (docs/rabbitmq-behaviour.md),
// so arrivals are worked out from what is left: the change in depth since the
// previous Sample plus the Messages Volverán itself took out in between.
//
// It is an estimate. Consumers outside Volverán hide arrivals, and management
// depth lags by a few seconds, so a take-out can land in a different Sample
// interval from its depth change.

/** Null (unknown, never zero) on the first Sample of a queue; never negative. */
export function estimateArrivals(reading: { previousDepth: number | null; depth: number; takenOut: number }): number | null {
  if (reading.previousDepth === null) return null;
  return Math.max(0, reading.depth - reading.previousDepth + reading.takenOut);
}
