// Message list entries and detail: x-death parsing, body rendering and the
// Delivery Budget as shown for each held Message.
import { describe, expect, it } from 'vitest';
import {
  deliveryCount,
  messageDetail,
  messageSummary,
  parseXDeath,
  renderBody,
  type Delivery,
} from '../../src/server/triage/message-view.js';

describe('renderBody', () => {
  it('pretty-prints a JSON body declared as application/json', () => {
    expect(renderBody(Buffer.from('{"a":1,"b":[true]}'), 'application/json')).toEqual({
      kind: 'json',
      size: 18,
      text: '{\n  "a": 1,\n  "b": [\n    true\n  ]\n}',
    });
  });

  it('treats +json media types and parameters as JSON', () => {
    expect(renderBody(Buffer.from('[1]'), 'application/vnd.orders+json; charset=utf-8')).toMatchObject({
      kind: 'json',
      text: '[\n  1\n]',
    });
  });

  it('shows a body declared as JSON that does not parse as text', () => {
    expect(renderBody(Buffer.from('{"broken"'), 'application/json')).toEqual({
      kind: 'text',
      size: 9,
      text: '{"broken"',
    });
  });

  it('shows text/* bodies as-is, even when they look like JSON', () => {
    expect(renderBody(Buffer.from('{"a":1}'), 'text/plain')).toEqual({ kind: 'text', size: 7, text: '{"a":1}' });
    expect(renderBody(Buffer.from('<a>é</a>'), 'application/xml')).toMatchObject({ kind: 'text', text: '<a>é</a>' });
  });

  it('sniffs JSON objects and arrays when there is no content type', () => {
    expect(renderBody(Buffer.from(' {"x":"y"} '))).toMatchObject({ kind: 'json', text: '{\n  "x": "y"\n}' });
  });

  it('sniffs readable UTF-8 as text when there is no content type', () => {
    expect(renderBody(Buffer.from('order 42 failed\n\ttwice'))).toMatchObject({
      kind: 'text',
      text: 'order 42 failed\n\ttwice',
    });
    expect(renderBody(Buffer.from('42'), 'application/octet-stream')).toMatchObject({ kind: 'text', text: '42' });
  });

  it('shows anything else as hex and base64', () => {
    const bytes = Buffer.from([0x00, 0xff, 0x10, 0x41]);
    expect(renderBody(bytes)).toEqual({ kind: 'binary', size: 4, hex: '00ff1041', base64: 'AP8QQQ==' });
    expect(renderBody(Buffer.from('a\u0001b'))).toMatchObject({ kind: 'binary', hex: '610162' });
  });

  it('shows invalid UTF-8 as binary even when declared as text', () => {
    expect(renderBody(Buffer.from([0xc3, 0x28]), 'text/plain')).toMatchObject({ kind: 'binary', hex: 'c328' });
  });

  it('shows compressed bodies as binary', () => {
    expect(renderBody(Buffer.from('{"a":1}'), 'application/json', 'gzip')).toMatchObject({ kind: 'binary' });
  });
});

describe('parseXDeath', () => {
  it('reads every entry, most recent first, with times as ISO strings', () => {
    const headers = {
      'x-death': [
        {
          count: 2,
          reason: 'expired',
          queue: 'orders.retry',
          time: { '!': 'timestamp', value: 1792139557 },
          exchange: 'orders.dlx',
          'routing-keys': ['orders.created'],
          'original-expiration': '100',
        },
        {
          count: 1,
          reason: 'rejected',
          queue: 'orders.work',
          time: { '!': 'timestamp', value: 1792139500 },
          exchange: 'orders',
          'routing-keys': ['orders.created', 'orders.cc'],
        },
      ],
    };
    expect(parseXDeath(headers)).toEqual([
      {
        queue: 'orders.retry',
        reason: 'expired',
        count: 2,
        time: '2026-10-16T08:32:37.000Z',
        exchange: 'orders.dlx',
        routingKeys: ['orders.created'],
        originalExpiration: '100',
      },
      {
        queue: 'orders.work',
        reason: 'rejected',
        count: 1,
        time: '2026-10-16T08:31:40.000Z',
        exchange: 'orders',
        routingKeys: ['orders.created', 'orders.cc'],
        originalExpiration: null,
      },
    ]);
  });

  it('returns no entries when the header is missing or not a list', () => {
    expect(parseXDeath(undefined)).toEqual([]);
    expect(parseXDeath({})).toEqual([]);
    expect(parseXDeath({ 'x-death': 'rejected' })).toEqual([]);
  });

  it('tolerates entries with missing or odd fields', () => {
    expect(
      parseXDeath({ 'x-death': [{ reason: 'maxlen', time: 1792139557, 'routing-keys': 'single' }, 'junk', null] }),
    ).toEqual([
      {
        queue: null,
        reason: 'maxlen',
        count: null,
        time: '2026-10-16T08:32:37.000Z',
        exchange: null,
        routingKeys: ['single'],
        originalExpiration: null,
      },
    ]);
  });

  it('accepts byte-string values as decoded by amqplib', () => {
    expect(
      parseXDeath({ 'x-death': [{ queue: Buffer.from('q'), reason: Buffer.from('rejected'), count: 3 }] })[0],
    ).toMatchObject({
      queue: 'q',
      reason: 'rejected',
      count: 3,
    });
  });
});

function delivery(
  overrides: { properties?: Record<string, unknown>; content?: Buffer; routingKey?: string } = {},
): Delivery {
  return {
    fields: { exchange: '', routingKey: overrides.routingKey ?? 'orders.dlq', redelivered: false },
    properties: { headers: {}, ...overrides.properties },
    content: overrides.content ?? Buffer.from('{}'),
  };
}

const rejectedHeaders = {
  'x-death': [
    {
      count: 1,
      reason: 'rejected',
      queue: 'orders.work',
      time: { '!': 'timestamp', value: 1792139500 },
      exchange: 'orders',
      'routing-keys': ['orders.created'],
    },
  ],
  'x-first-death-reason': 'rejected',
  'x-last-death-reason': 'rejected',
};

const classic = { type: 'classic', deliveryLimit: null, deadLetterExchange: false } as const;

describe('messageSummary', () => {
  it('shows message_id, routing key, timestamp, dead-letter reason, original queue and size', () => {
    const d = delivery({
      routingKey: 'orders.created',
      content: Buffer.from('{"order":1}'),
      properties: { messageId: 'm-1', timestamp: 1792139557, headers: rejectedHeaders },
    });
    expect(messageSummary(7, d, classic)).toEqual({
      handle: 7,
      messageId: 'm-1',
      routingKey: 'orders.created',
      timestamp: '2026-10-16T08:32:37.000Z',
      deadLetterReason: 'rejected',
      originalQueue: 'orders.work',
      size: 11,
      deliveryBudget: null,
      failureDetails: null,
    });
  });

  it('falls back to the Failure Details for the reason and original queue when there is no x-death', () => {
    const mt = {
      'MT-Fault-ExceptionType': 'System.TimeoutException',
      'MT-Fault-Message': 'The operation timed out',
      'MT-Fault-InputAddress': 'rabbitmq://localhost/prod/submit-order',
    };
    const summary = messageSummary(1, delivery({ properties: { headers: mt } }), classic);
    expect(summary).toMatchObject({ deadLetterReason: 'System.TimeoutException: The operation timed out', originalQueue: 'submit-order' });
    expect(summary.failureDetails).toMatchObject({ framework: 'masstransit', inputQueue: 'submit-order' });

    const spring = { 'x-exception-message': 'Listener threw exception', 'x-original-exchange': 'orders' };
    expect(messageSummary(1, delivery({ properties: { headers: spring } }), classic)).toMatchObject({
      deadLetterReason: 'Listener threw exception',
      originalQueue: null,
    });
    const typeOnly = { 'MT-Fault-ExceptionType': 'System.TimeoutException' };
    expect(messageSummary(1, delivery({ properties: { headers: typeOnly } }), classic).deadLetterReason).toBe('System.TimeoutException');
  });

  it('prefers x-death over the Failure Details when both are present', () => {
    const both = {
      ...rejectedHeaders,
      'MT-Fault-Message': 'boom',
      'MT-Fault-InputAddress': 'rabbitmq://localhost/submit-order',
    };
    const summary = messageSummary(1, delivery({ properties: { headers: both } }), classic);
    expect(summary).toMatchObject({ deadLetterReason: 'rejected', originalQueue: 'orders.work' });
    expect(summary.failureDetails?.message).toBe('boom');
  });

  it('takes the original queue from the most recent x-death entry', () => {
    const twoDeaths = { 'x-death': [{ reason: 'expired', queue: 'orders.retry' }, { reason: 'rejected', queue: 'orders.work' }] };
    expect(messageSummary(1, delivery({ properties: { headers: twoDeaths } }), classic).originalQueue).toBe('orders.retry');
  });

  it('shows the Delivery Budget on quorum queues and warns when 1 is left', () => {
    const d = delivery({ properties: { headers: { 'x-delivery-count': 4 } } });
    expect(messageSummary(1, d, { type: 'quorum', deliveryLimit: 5, deadLetterExchange: false }).deliveryBudget).toEqual({
      remaining: 1,
      warning: 'Delivery Budget 1: if this Checkout is lost, the broker drops this Message.',
    });
    expect(messageSummary(1, d, { type: 'quorum', deliveryLimit: 20, deadLetterExchange: false }).deliveryBudget).toEqual({
      remaining: 16,
      warning: null,
    });
  });

  it('counts a quorum Message without x-delivery-count as having its whole budget', () => {
    expect(
      messageSummary(1, delivery(), { type: 'quorum', deliveryLimit: 20, deadLetterExchange: true }).deliveryBudget,
    ).toEqual({ remaining: 20, warning: null });
  });

  it('uses the most recent x-death entry for the reason, then x-last-death-reason', () => {
    const twoDeaths = { 'x-death': [{ reason: 'expired' }, { reason: 'rejected' }] };
    expect(messageSummary(1, delivery({ properties: { headers: twoDeaths } }), classic).deadLetterReason).toBe('expired');
    expect(
      messageSummary(1, delivery({ properties: { headers: { 'x-last-death-reason': 'maxlen' } } }), classic).deadLetterReason,
    ).toBe('maxlen');
  });

  it('leaves absent fields null', () => {
    expect(messageSummary(1, delivery({ properties: { headers: undefined } }), classic)).toMatchObject({
      messageId: null,
      timestamp: null,
      deadLetterReason: null,
      originalQueue: null,
    });
  });
});

describe('deliveryCount', () => {
  it('reads x-delivery-count', () => {
    expect(deliveryCount({ 'x-delivery-count': 3 }, 'quorum')).toBe(3);
    expect(deliveryCount({ 'x-delivery-count': 1 }, 'classic')).toBe(1);
  });

  it('counts a quorum Message without the header as never redelivered', () => {
    expect(deliveryCount({}, 'quorum')).toBe(0);
    expect(deliveryCount(undefined, 'quorum')).toBe(0);
  });

  it('is unknown on classic queues without the header, which do not track it', () => {
    expect(deliveryCount({}, 'classic')).toBeNull();
  });
});

describe('messageDetail', () => {
  it('shows every property and header, the x-death history, the delivery count and the body', () => {
    const d = delivery({
      routingKey: 'orders.created',
      content: Buffer.from('{"order":42}'),
      properties: {
        messageId: 'm-1',
        contentType: 'application/json',
        contentEncoding: undefined,
        correlationId: 'c-9',
        deliveryMode: 2,
        timestamp: 1792139557,
        appId: 'orders-svc',
        headers: { ...rejectedHeaders, 'x-delivery-count': 2, tenant: 'acme' },
      },
    });

    const detail = messageDetail(3, d, { type: 'quorum', deliveryLimit: null, deadLetterExchange: false });

    expect(detail).toMatchObject({
      handle: 3,
      messageId: 'm-1',
      routingKey: 'orders.created',
      exchange: '',
      redelivered: false,
      deadLetterReason: 'rejected',
      deliveryCount: 2,
      properties: {
        messageId: 'm-1',
        contentType: 'application/json',
        correlationId: 'c-9',
        deliveryMode: 2,
        timestamp: '2026-10-16T08:32:37.000Z',
        appId: 'orders-svc',
      },
      xDeath: [
        { queue: 'orders.work', reason: 'rejected', count: 1, exchange: 'orders', routingKeys: ['orders.created'] },
      ],
      body: { kind: 'json', text: '{\n  "order": 42\n}' },
    });
    expect(Object.keys(detail.properties)).not.toContain('contentEncoding');
    expect(detail.properties).not.toHaveProperty('headers');
    expect(detail.headers).toMatchObject({ tenant: 'acme', 'x-delivery-count': 2, 'x-first-death-reason': 'rejected' });
    expect(detail.headers['x-death']).toEqual([
      {
        count: 1,
        reason: 'rejected',
        queue: 'orders.work',
        time: '2026-10-16T08:31:40.000Z',
        exchange: 'orders',
        'routing-keys': ['orders.created'],
      },
    ]);
  });

  it('makes header values that are not plain JSON readable', () => {
    const d = delivery({
      properties: {
        headers: {
          bytes: Buffer.from([1, 2, 255]),
          big: 9007199254740993n,
          decimal: { '!': 'decimal', value: { places: 2, digits: 1234 } },
          when: { '!': 'timestamp', value: 0 },
        },
      },
    });
    expect(messageDetail(1, d, classic).headers).toEqual({
      bytes: { bytes: 'AQL/' },
      big: '9007199254740993',
      decimal: '12.34',
      when: '1970-01-01T00:00:00.000Z',
    });
  });

  it('uses the content type to render the body', () => {
    const d = delivery({ content: Buffer.from('plain'), properties: { contentType: 'text/plain' } });
    expect(messageDetail(1, d, classic).body).toEqual({ kind: 'text', size: 5, text: 'plain' });
  });
});
