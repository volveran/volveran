// Pure (no I/O): the republish rules (ADR 0005) shared by every action that
// sends a Message somewhere (Replay, Move) and by Restore. The body, every
// property and every other header are kept; the routing and dead-letter
// headers are removed and the provenance headers added.
//
// `CC` and `BCC` are sender-selected routing: kept, they would copy the
// Message to queues the Operator did not pick. `x-death`, `x-first-death-*`,
// `x-last-death-*`, `x-delivery-count` and `x-acquired-count` would mislead
// consumers that count retries (the broker passes a client-supplied
// `x-death` through untouched). The Failure Details Spring AMQP and
// MassTransit wrote (`x-exception-*`, `x-original-exchange`,
// `x-original-routingKey`, `MT-Reason`, `MT-Fault-*`, `MT-Host-*`) would show
// the consumer a stale exception (ADR 0010). The Audit Entry keeps the
// originals.
import type * as amqp from 'amqplib';

/** Where a republished Message comes from, for its `x-volveran-*` headers. */
export interface Provenance {
  /** New for every republish (`x-volveran-replay-id`): links a Message that dies again to this Audit Entry's history. */
  replayId: string;
  /** The queue the Message was taken from (`x-volveran-from`). */
  from: string;
}

export const REPLAY_ID_HEADER = 'x-volveran-replay-id';
export const FROM_HEADER = 'x-volveran-from';

const REMOVED = new Set([
  'CC',
  'BCC',
  'x-death',
  'x-delivery-count',
  'x-acquired-count',
  'x-original-exchange',
  'x-original-routingKey',
  'MT-Reason',
]);
const REMOVED_PREFIXES = ['x-first-death-', 'x-last-death-', 'x-exception-', 'MT-Fault-', 'MT-Host-'];

function removed(name: string): boolean {
  return REMOVED.has(name) || REMOVED_PREFIXES.some((prefix) => name.startsWith(prefix));
}

/** The headers a republished Message carries: `headers` without the routing, dead-letter and Failure Details headers, plus provenance. */
export function cleanHeaders(headers: Record<string, unknown> | undefined, provenance: Provenance): Record<string, unknown> {
  const kept = Object.entries(headers ?? {}).filter(([name]) => !removed(name));
  return { ...Object.fromEntries(kept), [REPLAY_ID_HEADER]: provenance.replayId, [FROM_HEADER]: provenance.from };
}

/** Message properties as amqplib decodes them (or as stored in an Audit Entry). */
export type RepublishProperties = Partial<Record<keyof amqp.MessageProperties, unknown>>;

const COPIED = [
  'contentType',
  'contentEncoding',
  'deliveryMode',
  'priority',
  'correlationId',
  'replyTo',
  'expiration',
  'messageId',
  'timestamp',
  'type',
  // The broker refuses the publish (reported as failed) when it names a user other than the profile's.
  'userId',
  'appId',
] as const;

/**
 * Publish options that reproduce `properties` with cleaned headers. The
 * deprecated `clusterId` property is not copied.
 */
export function republishOptions(properties: RepublishProperties, provenance: Provenance): amqp.Options.Publish {
  const options: Record<string, unknown> = {};
  for (const key of COPIED) {
    const value = properties[key];
    if (value !== undefined && value !== null) options[key] = value;
  }
  options.headers = cleanHeaders(properties.headers as Record<string, unknown> | undefined, provenance);
  return options as amqp.Options.Publish;
}
