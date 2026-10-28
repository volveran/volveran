// Pure Message presentation (no I/O): the list entry and the detail view of a
// held delivery, with its readable x-death history, its body rendered by
// content type, and its Delivery Budget on quorum queues.
import { deliveryBudget } from './delivery-budget.js';
import type { CheckoutQueueType } from './queue-list.js';
import { isRecord } from '../is-record.js';
import type { MessageDetail, MessageSummary, RenderedBody, XDeathEntry } from '../../shared/checkout.js';

export type { MessageDetail, MessageSummary, RenderedBody, XDeathEntry };

/** The source queue facts a Message's presentation depends on. */
export interface QueueInfo {
  type: CheckoutQueueType;
  /** Effective `delivery-limit` (quorum only); null when there is none. */
  deliveryLimit: number | null;
  /** Whether the queue has a dead-letter exchange (argument or policy). */
  deadLetterExchange: boolean;
}

/** The parts of an amqplib delivery this module reads. */
export interface Delivery {
  fields: { exchange: string; routingKey: string; redelivered: boolean };
  /** AMQP properties (amqplib's MessageProperties); every set one is shown. */
  properties: {
    headers?: Record<string, unknown> | undefined;
    messageId?: unknown;
    timestamp?: unknown;
    contentType?: unknown;
    contentEncoding?: unknown;
  };
  content: Buffer;
}

export function messageSummary(handle: number, d: Delivery, queue: QueueInfo): MessageSummary {
  const { headers } = d.properties;
  const latest = parseXDeath(headers)[0];
  return {
    handle,
    messageId: asString(d.properties.messageId),
    routingKey: d.fields.routingKey,
    timestamp: asTime(d.properties.timestamp),
    deadLetterReason: latest?.reason ?? asString(headers?.['x-last-death-reason']),
    originalQueue: latest?.queue ?? null,
    size: d.content.length,
    deliveryBudget: deliveryBudget({
      deliveryCount: deliveryCount(headers, queue.type),
      deliveryLimit: queue.deliveryLimit,
      deadLetterExchange: queue.deadLetterExchange,
    }),
  };
}

/**
 * Delivery attempts used, from `x-delivery-count`. Quorum queues omit the
 * header until the first redelivery (so 0); classic queues don't track it.
 */
export function deliveryCount(headers: Record<string, unknown> | undefined, queueType: CheckoutQueueType): number | null {
  const count = asNumber(headers?.['x-delivery-count']);
  if (count !== null) return count;
  return queueType === 'quorum' ? 0 : null;
}

/**
 * Picks how to show a body from its `content_type`, sniffing the content when
 * the type is missing or doesn't fit: JSON pretty-printed, text as-is,
 * anything else (including compressed bodies) as hex and base64.
 */
export function renderBody(content: Buffer, contentType?: string, contentEncoding?: string): RenderedBody {
  const size = content.length;
  const body = classifyBody(content, contentType, contentEncoding);
  switch (body.kind) {
    case 'json':
      return { kind: 'json', size, text: JSON.stringify(body.value, null, 2) };
    case 'text':
      return { kind: 'text', size, text: body.text };
    case 'binary':
      return { kind: 'binary', size, hex: content.toString('hex'), base64: content.toString('base64') };
  }
}

/** Whether a body reads as JSON, text or binary: the kind renderBody shows it as. */
export function bodyKind(content: Buffer, contentType?: string, contentEncoding?: string): RenderedBody['kind'] {
  return classifyBody(content, contentType, contentEncoding).kind;
}

type ClassifiedBody = { kind: 'json'; value: unknown } | { kind: 'text'; text: string } | { kind: 'binary' };

function classifyBody(content: Buffer, contentType?: string, contentEncoding?: string): ClassifiedBody {
  const binary: ClassifiedBody = { kind: 'binary' };
  if (contentEncoding && !/^(identity|utf-?8)$/i.test(contentEncoding.trim())) return binary;

  const text = decodeUtf8(content);
  if (text === undefined) return binary;

  const mime = (contentType ?? '').split(';')[0]!.trim().toLowerCase();
  const declaredJson = mime === 'application/json' || mime.endsWith('+json');
  const declaredText = mime.startsWith('text/') || mime === 'application/xml' || mime.endsWith('+xml');

  if (declaredJson || !declaredText) {
    const json = parseJson(text, declaredJson);
    if (json !== undefined) return { kind: 'json', value: json };
  }
  if (declaredText || declaredJson || looksLikeText(text)) return { kind: 'text', text };
  return binary;
}

function decodeUtf8(content: Buffer): string | undefined {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(content);
  } catch {
    return undefined;
  }
}

/** Parses JSON; when sniffing, only objects and arrays count (so "42" stays text). */
function parseJson(text: string, declared: boolean): unknown {
  const trimmed = text.trim();
  if (!declared && !/^[[{]/.test(trimmed)) return undefined;
  try {
    return JSON.parse(trimmed);
  } catch {
    return undefined;
  }
}

function looksLikeText(text: string): boolean {
  // No control characters other than tab, newline and carriage return.
  return !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(text);
}

/**
 * Reads the `x-death` header, most recent entry first (the broker's order).
 * Tolerates a missing header and publisher-forged shapes: entries that are
 * not tables are skipped and unreadable fields become null.
 */
export function parseXDeath(headers: Record<string, unknown> | undefined): XDeathEntry[] {
  const raw = headers?.['x-death'];
  if (!Array.isArray(raw)) return [];
  return raw.filter(isRecord).map((e) => ({
    queue: asString(e.queue),
    reason: asString(e.reason),
    count: asNumber(e.count),
    time: asTime(e.time),
    exchange: asString(e.exchange),
    routingKeys: (Array.isArray(e['routing-keys']) ? e['routing-keys'] : [e['routing-keys']])
      .map(asString)
      .filter((k): k is string => k !== null),
    originalExpiration: asString(e['original-expiration']),
  }));
}

function asString(v: unknown): string | null {
  if (typeof v === 'string') return v;
  if (Buffer.isBuffer(v)) return v.toString('utf8');
  return null;
}

function asNumber(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'bigint') return Number(v);
  return null;
}

/** AMQP timestamps are seconds; amqplib decodes typed ones as `{ '!': 'timestamp', value }`. */
function asTime(v: unknown): string | null {
  const seconds = isRecord(v) && v['!'] === 'timestamp' ? asNumber(v.value) : asNumber(v);
  return seconds === null ? null : new Date(seconds * 1000).toISOString();
}

export function messageDetail(handle: number, d: Delivery, queue: QueueInfo): MessageDetail {
  const { headers, ...props } = d.properties;
  const properties: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(props)) {
    if (value === undefined || value === null) continue;
    properties[key] = key === 'timestamp' ? asTime(value) : jsonSafe(value);
  }
  return {
    ...messageSummary(handle, d, queue),
    exchange: d.fields.exchange,
    redelivered: d.fields.redelivered,
    deliveryCount: deliveryCount(headers, queue.type),
    deliveryLimit: queue.deliveryLimit,
    properties,
    headers: (jsonSafe(headers ?? {}) as Record<string, unknown>) ?? {},
    xDeath: parseXDeath(headers),
    body: renderBody(d.content, asString(props.contentType) ?? undefined, asString(props.contentEncoding) ?? undefined),
  };
}

/**
 * Turns AMQP field values as amqplib decodes them into readable JSON: byte
 * arrays become `{ bytes: <base64> }`, timestamps ISO strings, decimals and
 * 64-bit integers strings.
 */
function jsonSafe(v: unknown): unknown {
  if (Buffer.isBuffer(v)) return { bytes: v.toString('base64') };
  if (typeof v === 'bigint') return v.toString();
  if (Array.isArray(v)) return v.map(jsonSafe);
  if (isRecord(v)) {
    if (v['!'] === 'timestamp') return asTime(v);
    if (v['!'] === 'decimal' && isRecord(v.value)) return formatDecimal(v.value);
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, jsonSafe(x)]));
  }
  return v;
}

function formatDecimal(value: Record<string, unknown>): string {
  const places = asNumber(value.places) ?? 0;
  const digits = asNumber(value.digits) ?? 0;
  const abs = String(Math.abs(digits)).padStart(places + 1, '0');
  const text = places > 0 ? `${abs.slice(0, -places)}.${abs.slice(-places)}` : abs;
  return digits < 0 ? `-${text}` : text;
}
