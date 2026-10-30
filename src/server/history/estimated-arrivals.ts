// Pure: the estimated arrivals of a Sample. The broker does not count
// dead-lettered Messages in `message_stats.publish` (docs/rabbitmq-behaviour.md),
// so arrivals are worked out from what is left: the change in depth since the
// previous Sample plus the Messages Volverán itself took out in between.
//
// It is an estimate. Consumers outside Volverán hide arrivals, and management
// depth lags by a few seconds, so a take-out can land in a different Sample
// interval from its depth change, which is what bornOutArrivals allows for.

/** Null (unknown, never zero) on the first Sample of a queue; never negative. */
export function estimateArrivals(sample: { previousDepth: number | null; depth: number; takenOut: number }): number | null {
  if (sample.previousDepth === null) return null;
  return Math.max(0, sample.depth - sample.previousDepth + sample.takenOut);
}

/**
 * The arrivals a Sample's depth has borne out, as Alerts and the metrics count
 * them. Management depth lags Audit Entries, so depth 10 -> 10 with 10 taken out
 * estimates 10 arrivals that never happened, and the drop shows only in the next
 * Sample. So a rise in depth counts at once, and a take-out is held for one
 * Sample: a drop in that Sample settles it, and what no drop settles did hide
 * arrivals, which count then, one Sample late. A consumer outside Volverán can
 * settle a take-out too, and so hide arrivals, as it does anyway.
 *
 * `held` is the take-outs still unsettled from the Sample before; the answer's
 * `unsettled` is what to hold for the next one.
 */
export function bornOutArrivals(
  held: number,
  { depth, previousDepth, takenOut }: { depth: number; previousDepth: number | null; takenOut: number },
): { unsettled: number; arrived: number } {
  if (previousDepth === null) return { unsettled: held, arrived: 0 };
  const change = depth - previousDepth;
  const drop = Math.max(0, -change);
  return {
    unsettled: Math.max(0, takenOut - Math.max(0, drop - held)),
    arrived: Math.max(0, change) + Math.max(0, held - drop),
  };
}
