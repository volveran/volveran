// A held Message as the API shows it: the list entry and the detail, with its
// readable x-death history, its body rendered by content type, its Delivery
// Budget and its Failure Details. Mirrors src/server/triage/message-view.ts,
// failure-details.ts and replay-origin.ts, which use Node's Buffer and so do
// not run in the browser. The demo's headers never hold byte arrays, and its
// Messages carry Spring AMQP Failure Details only (no MassTransit).
import { deliveryBudget } from '../../../../src/server/triage/delivery-budget.js';
import type { FailureDetails, MessageDetail, MessageSummary, RenderedBody, XDeathEntry } from '../../../../src/shared/checkout.js';
import type { MoveDestination } from '../../../../src/shared/decisions.js';
import type { BrokerMessage, QueueType } from './broker.js';

/** The source queue facts a Message's presentation depends on. */
export interface QueueInfo {
  type: Exclude<QueueType, 'stream'>;
  deliveryLimit: number | null;
  deadLetterExchange: boolean;
}

export function messageSummary(handle: number, m: BrokerMessage, queue: QueueInfo): MessageSummary {
  const { headers } = m.properties;
  const latest = parseXDeath(headers)[0];
  const failure = failureDetails(headers);
  const fallbackReason = failure ? [failure.exceptionType, failure.message].filter((t) => t).join(': ') || null : null;
  return {
    handle,
    messageId: messageIdOf(m),
    routingKey: m.routingKey,
    timestamp: asTime(m.properties.timestamp),
    deadLetterReason: latest?.reason ?? asString(headers?.['x-last-death-reason']) ?? (latest ? null : fallbackReason),
    originalQueue: latest ? latest.queue : null,
    size: m.content.length,
    deliveryBudget: deliveryBudget({
      deliveryCount: deliveryCount(headers, queue.type),
      deliveryLimit: queue.deliveryLimit,
      deadLetterExchange: queue.deadLetterExchange,
    }),
    failureDetails: failure,
  };
}

/** The Message view, but for `diedAgain` and `rule`, which the Checkout adds. */
export function messageDetail(handle: number, m: BrokerMessage, queue: QueueInfo): Omit<MessageDetail, 'diedAgain' | 'rule'> {
  const { headers, ...props } = m.properties;
  const properties: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(props)) {
    if (value === undefined || value === null) continue;
    properties[name] = name === 'timestamp' ? asTime(value) : jsonSafe(value);
  }
  return {
    ...messageSummary(handle, m, queue),
    exchange: m.exchange,
    redelivered: m.redelivered,
    deliveryCount: deliveryCount(headers, queue.type),
    deliveryLimit: queue.deliveryLimit,
    properties,
    headers: jsonSafe(headers ?? {}) as Record<string, unknown>,
    xDeath: parseXDeath(headers),
    body: renderBody(m.content, props.contentType, props.contentEncoding),
  };
}

export function messageIdOf(m: Pick<BrokerMessage, 'properties'> | undefined): string | null {
  const id: unknown = m?.properties.messageId;
  return typeof id === 'string' ? id : id == null ? null : String(id);
}

function deliveryCount(headers: Record<string, unknown> | undefined, queueType: QueueInfo['type']): number | null {
  const count = asNumber(headers?.['x-delivery-count']);
  if (count !== null) return count;
  return queueType === 'quorum' ? 0 : null;
}

/** JSON pretty-printed, text as-is, anything else as hex and base64. */
export function renderBody(content: Uint8Array, contentType?: string, contentEncoding?: string): RenderedBody {
  const size = content.length;
  const body = classifyBody(content, contentType, contentEncoding);
  switch (body.kind) {
    case 'json':
      return { kind: 'json', size, text: JSON.stringify(body.value, null, 2) };
    case 'text':
      return { kind: 'text', size, text: body.text };
    case 'binary':
      return { kind: 'binary', size, hex: toHex(content), base64: toBase64(content) };
  }
}

type ClassifiedBody = { kind: 'json'; value: unknown } | { kind: 'text'; text: string } | { kind: 'binary' };

function classifyBody(content: Uint8Array, contentType?: string, contentEncoding?: string): ClassifiedBody {
  const binary: ClassifiedBody = { kind: 'binary' };
  if (contentEncoding && !/^(identity|utf-?8)$/i.test(contentEncoding.trim())) return binary;
  const text = bodyText(content);
  if (text === undefined) return binary;
  const mime = (contentType ?? '').split(';')[0]!.trim().toLowerCase();
  const declaredJson = mime === 'application/json' || mime.endsWith('+json');
  const declaredText = mime.startsWith('text/') || mime === 'application/xml' || mime.endsWith('+xml');
  if (declaredJson || !declaredText) {
    const json = parseJson(text, declaredJson);
    if (json !== undefined) return { kind: 'json', value: json };
  }
  if (declaredText || declaredJson || !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(text)) return { kind: 'text', text };
  return binary;
}

/** The body as UTF-8 text; undefined when it is not valid UTF-8. */
export function bodyText(content: Uint8Array): string | undefined {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(content);
  } catch {
    return undefined;
  }
}

function parseJson(text: string, declared: boolean): unknown {
  const trimmed = text.trim();
  if (!declared && !/^[[{]/.test(trimmed)) return undefined;
  try {
    return JSON.parse(trimmed);
  } catch {
    return undefined;
  }
}

/** The `x-death` header, most recent entry first (the broker's order). */
export function parseXDeath(headers: Record<string, unknown> | undefined): XDeathEntry[] {
  const raw = headers?.['x-death'];
  if (!Array.isArray(raw)) return [];
  return raw.filter(isRecord).map((e) => ({
    queue: asString(e.queue),
    reason: asString(e.reason),
    count: asNumber(e.count),
    time: asTime(e.time),
    exchange: asString(e.exchange),
    routingKeys: (Array.isArray(e['routing-keys']) ? e['routing-keys'] : [e['routing-keys']]).map(asString).filter((k): k is string => k !== null),
    originalExpiration: asString(e['original-expiration']),
  }));
}

/** Spring AMQP's Failure Details (RepublishMessageRecoverer's `x-exception-*` and `x-original-*`); null without them. */
export function failureDetails(headers: Record<string, unknown> | undefined): FailureDetails | null {
  if (!headers || !Object.keys(headers).some((n) => n.startsWith('x-exception-'))) return null;
  const extra: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (!name.startsWith('x-exception-') || name === 'x-exception-message' || name === 'x-exception-stacktrace') continue;
    const text = asText(value);
    if (text !== null) extra[name] = text;
  }
  return {
    framework: 'spring',
    exceptionType: null,
    message: asText(headers['x-exception-message']),
    stackTrace: asText(headers['x-exception-stacktrace']),
    consumerType: null,
    messageType: null,
    failedAt: null,
    retryCount: null,
    redeliveryCount: null,
    host: null,
    reason: null,
    originalExchange: asText(headers['x-original-exchange']),
    originalRoutingKey: asText(headers['x-original-routingKey']),
    inputQueue: null,
    extra,
  };
}

export type ReplayOrigin = { ok: true; queue: string } | { ok: false; reason: string; suggestedMove?: MoveDestination };

/** Where Replay sends a Message: the queue of its most recent x-death entry (ADR 0005). */
export function replayOrigin(headers: Record<string, unknown> | undefined): ReplayOrigin {
  const latest = parseXDeath(headers)[0];
  if (latest) {
    if (latest.queue === null || latest.queue === '') {
      return { ok: false, reason: 'The most recent x-death entry of this Message names no queue, so there is nowhere to Replay it to. Move it instead.' };
    }
    return { ok: true, queue: latest.queue };
  }
  const details = failureDetails(headers);
  if (details?.originalExchange != null) {
    const exchange = details.originalExchange;
    const routingKey = details.originalRoutingKey ?? '';
    return {
      ok: false,
      reason: `Spring AMQP does not record the queue that failed this Message, only that it was first published to the exchange "${exchange}" with the routing key "${routingKey}". Replay never re-routes through an exchange: Move it there if every queue bound to it should get it again.`,
      suggestedMove: { exchange, routingKey },
    };
  }
  return {
    ok: false,
    reason: 'This Message has no x-death history, so there is no queue it was dead-lettered from to Replay it to. Move it instead.',
  };
}

/** Readable JSON of AMQP field values: typed timestamps become ISO times. */
function jsonSafe(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(jsonSafe);
  if (isRecord(v)) {
    if (v['!'] === 'timestamp') return asTime(v);
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, jsonSafe(x)]));
  }
  return v;
}

function asString(v: unknown): string | null {
  return typeof v === 'string' ? v : null;
}

function asText(v: unknown): string | null {
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  return null;
}

function asNumber(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

/** AMQP timestamps are seconds; header tables carry them typed (`{ '!': 'timestamp', value }`). */
function asTime(v: unknown): string | null {
  const seconds = isRecord(v) && v['!'] === 'timestamp' ? asNumber(v.value) : asNumber(v);
  return seconds === null ? null : new Date(seconds * 1000).toISOString();
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v) && !ArrayBuffer.isView(v);
}

export function toBase64(bytes: Uint8Array): string {
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

function toHex(bytes: Uint8Array): string {
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}
