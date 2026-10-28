// Pure (no I/O): the Failure Details a client framework writes into a
// Message's headers when it gives up on it. Spring AMQP's
// RepublishMessageRecoverer writes `x-exception-*` and `x-original-*`;
// MassTransit writes `MT-Reason`, `MT-Fault-*` and `MT-Host-*` (header names
// from RepublishMessageRecoverer in spring-amqp and MessageHeaders in
// MassTransit.Abstractions). Neither dead-letters through the broker, so these
// Messages usually carry no x-death.
import { isRecord } from '../is-record.js';
import type { FailureDetails } from '../../shared/checkout.js';

export type { FailureDetails };

const SPRING_PREFIX = 'x-exception-';
const MT_FAULT_PREFIX = 'MT-Fault-';
const MT_HOST_PREFIX = 'MT-Host-';

/** The Failure Details in `headers`, or null when no framework wrote any. */
export function failureDetails(headers: Record<string, unknown> | undefined): FailureDetails | null {
  if (!headers) return null;
  const names = Object.keys(headers);
  if (names.some((n) => n === 'MT-Reason' || n.startsWith(MT_FAULT_PREFIX))) return massTransit(headers);
  if (names.some((n) => n.startsWith(SPRING_PREFIX))) return spring(headers);
  return null;
}

function empty(framework: FailureDetails['framework']): FailureDetails {
  return {
    framework,
    exceptionType: null,
    message: null,
    stackTrace: null,
    consumerType: null,
    messageType: null,
    faultAt: null,
    retryCount: null,
    redeliveryCount: null,
    host: null,
    reason: null,
    originalExchange: null,
    originalRoutingKey: null,
    inputQueue: null,
    extra: {},
  };
}

const SPRING_READ = new Set(['x-exception-message', 'x-exception-stacktrace']);

function spring(h: Record<string, unknown>): FailureDetails {
  const extra: Record<string, string> = {};
  for (const [name, value] of Object.entries(h)) {
    if (!name.startsWith(SPRING_PREFIX) || SPRING_READ.has(name)) continue;
    const text = asText(value);
    if (text !== null) extra[name] = text;
  }
  return {
    ...empty('spring'),
    message: asText(h['x-exception-message']),
    stackTrace: asText(h['x-exception-stacktrace']),
    originalExchange: asText(h['x-original-exchange']),
    originalRoutingKey: asText(h['x-original-routingKey']),
    extra,
  };
}

const MT_READ = new Set(
  ['ExceptionType', 'Message', 'StackTrace', 'ConsumerType', 'MessageType', 'Timestamp', 'RetryCount', 'RedeliveryCount'].map(
    (n) => MT_FAULT_PREFIX + n,
  ),
);

function massTransit(h: Record<string, unknown>): FailureDetails {
  const extra: Record<string, string> = {};
  const host: Record<string, string> = {};
  for (const [name, value] of Object.entries(h)) {
    const text = asText(value);
    if (text === null) continue;
    if (name.startsWith(MT_HOST_PREFIX)) host[name.slice(MT_HOST_PREFIX.length)] = text;
    else if (name.startsWith(MT_FAULT_PREFIX) && !MT_READ.has(name)) extra[name] = text;
  }
  const field = (name: string) => asText(h[MT_FAULT_PREFIX + name]);
  const reason = asText(h['MT-Reason'])?.trim().toLowerCase();
  const inputAddress = field('InputAddress');
  return {
    ...empty('masstransit'),
    exceptionType: field('ExceptionType'),
    message: field('Message'),
    stackTrace: field('StackTrace'),
    consumerType: field('ConsumerType'),
    messageType: field('MessageType'),
    faultAt: asFaultTime(h[MT_FAULT_PREFIX + 'Timestamp']),
    retryCount: asCount(h[MT_FAULT_PREFIX + 'RetryCount']),
    redeliveryCount: asCount(h[MT_FAULT_PREFIX + 'RedeliveryCount']),
    host: Object.keys(host).length > 0 ? host : null,
    reason: reason === 'fault' || reason === 'skip' ? reason : null,
    inputQueue: inputAddress === null ? null : queueOfAddress(inputAddress),
    extra,
  };
}

/**
 * The queue a MassTransit address names: its last path segment, without the
 * query string, URL-decoded (`rabbitmq://host/vhost/queue?bind=true`). Null
 * when the address has no path.
 */
function queueOfAddress(address: string): string | null {
  const withoutQuery = address.split(/[?#]/)[0]!;
  const path = withoutQuery.replace(/^[A-Za-z][A-Za-z0-9+.-]*:\/\/[^/]*/, '');
  const last = path.split('/').pop() ?? '';
  if (last === '') return null;
  try {
    return decodeURIComponent(last);
  } catch {
    return last;
  }
}

/** Text of a scalar header value; byte arrays are decoded as UTF-8. */
function asText(v: unknown): string | null {
  if (typeof v === 'string') return v;
  if (Buffer.isBuffer(v)) return v.toString('utf8');
  if (typeof v === 'number' || typeof v === 'bigint' || typeof v === 'boolean') return String(v);
  return null;
}

function asCount(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'bigint') return Number(v);
  const text = asText(v)?.trim();
  return text && /^\d+$/.test(text) ? Number(text) : null;
}

/** ISO time from text or an AMQP timestamp (seconds); text that is not a time is kept as written. */
function asFaultTime(v: unknown): string | null {
  if (isRecord(v) && v['!'] === 'timestamp') v = v.value;
  if (typeof v === 'number' || typeof v === 'bigint') return new Date(Number(v) * 1000).toISOString();
  const text = asText(v);
  if (text === null) return null;
  const ms = Date.parse(text);
  return Number.isNaN(ms) ? text : new Date(ms).toISOString();
}
