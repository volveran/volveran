// Filters over held Messages: each filter kind, its edge cases (a missing
// header, a body that is not text, several x-death entries) and parsing.
import { describe, expect, it } from 'vitest';
import { matchesFilter, parseFilter, type Filter } from '../../src/server/triage/filters.js';
import type { Delivery } from '../../src/server/triage/message-view.js';

function delivery(overrides: {
  routingKey?: string;
  headers?: Record<string, unknown>;
  body?: string | Buffer;
  contentType?: string;
  contentEncoding?: string;
} = {}): Delivery {
  return {
    fields: { exchange: 'orders.dlx', routingKey: overrides.routingKey ?? 'orders.created', redelivered: false },
    properties: {
      headers: overrides.headers,
      contentType: overrides.contentType,
      contentEncoding: overrides.contentEncoding,
    },
    content: Buffer.isBuffer(overrides.body) ? overrides.body : Buffer.from(overrides.body ?? ''),
  };
}

const matches = (filter: Filter, d: Delivery) => matchesFilter(filter, d);

describe('routing key filter', () => {
  it('matches the whole routing key, with * and ? as wildcards', () => {
    const d = delivery({ routingKey: 'orders.created.eu' });
    expect(matches([{ kind: 'routing-key', value: 'orders.created.eu' }], d)).toBe(true);
    expect(matches([{ kind: 'routing-key', value: 'orders.created' }], d)).toBe(false);
    expect(matches([{ kind: 'routing-key', value: 'orders.*' }], d)).toBe(true);
    expect(matches([{ kind: 'routing-key', value: '*.created.e?' }], d)).toBe(true);
    expect(matches([{ kind: 'routing-key', value: 'payments.*' }], d)).toBe(false);
  });
});

describe('header filter', () => {
  const d = delivery({
    headers: { tenant: 'acme-eu', attempt: 3, flag: true, raw: Buffer.from('bytes-value'), nested: { a: 1 } },
  });

  it('matches a header value as a whole, with wildcards', () => {
    expect(matches([{ kind: 'header', name: 'tenant', value: 'acme-eu' }], d)).toBe(true);
    expect(matches([{ kind: 'header', name: 'tenant', value: 'acme*' }], d)).toBe(true);
    expect(matches([{ kind: 'header', name: 'tenant', value: 'acme' }], d)).toBe(false);
  });

  it('compares numbers, booleans and byte arrays by their text', () => {
    expect(matches([{ kind: 'header', name: 'attempt', value: '3' }], d)).toBe(true);
    expect(matches([{ kind: 'header', name: 'flag', value: 'true' }], d)).toBe(true);
    expect(matches([{ kind: 'header', name: 'raw', value: 'bytes-value' }], d)).toBe(true);
  });

  it('without a value, matches any Message carrying the header', () => {
    expect(matches([{ kind: 'header', name: 'nested' }], d)).toBe(true);
    expect(matches([{ kind: 'header', name: 'missing' }], d)).toBe(false);
    expect(matches([{ kind: 'header', name: 'tenant' }], delivery())).toBe(false);
  });

  it('never matches a value when the header is missing', () => {
    expect(matches([{ kind: 'header', name: 'missing', value: '*' }], d)).toBe(false);
    expect(matches([{ kind: 'header', name: 'tenant', value: 'acme-eu' }], delivery())).toBe(false);
  });

  it('never matches a value against a table header', () => {
    expect(matches([{ kind: 'header', name: 'nested', value: '*' }], d)).toBe(false);
  });
});

describe('x-death filters', () => {
  // Most recent entry first, as the broker writes it: expired from the retry
  // queue after being rejected from the work queue.
  const d = delivery({
    headers: {
      'x-death': [
        { count: 1, reason: 'expired', queue: 'orders.retry', exchange: 'orders.retry', 'routing-keys': ['orders.created'] },
        { count: 2, reason: 'rejected', queue: 'orders.work', exchange: 'orders', 'routing-keys': ['orders.created'] },
      ],
    },
  });
  const noHistory = delivery({ headers: { other: 'x' } });

  it('matches a reason found in any x-death entry', () => {
    expect(matches([{ kind: 'x-death-reason', value: 'rejected' }], d)).toBe(true);
    expect(matches([{ kind: 'x-death-reason', value: 'expired' }], d)).toBe(true);
    expect(matches([{ kind: 'x-death-reason', value: 'maxlen' }], d)).toBe(false);
    expect(matches([{ kind: 'x-death-reason', value: 'rejected' }], noHistory)).toBe(false);
  });

  it('matches the original queue, the one in the most recent x-death entry, with wildcards', () => {
    expect(matches([{ kind: 'original-queue', value: 'orders.retry' }], d)).toBe(true);
    expect(matches([{ kind: 'original-queue', value: '*.retry' }], d)).toBe(true);
    // An older entry is not where the Message was dead-lettered from last.
    expect(matches([{ kind: 'original-queue', value: 'orders.work' }], d)).toBe(false);
    expect(matches([{ kind: 'original-queue', value: '*' }], noHistory)).toBe(false);
  });

  it('skips x-death entries that are not tables', () => {
    const forged = delivery({ headers: { 'x-death': ['junk', { reason: 'rejected', queue: 'orders.work' }] } });
    expect(matches([{ kind: 'x-death-reason', value: 'rejected' }], forged)).toBe(true);
    expect(matches([{ kind: 'original-queue', value: 'orders.work' }], forged)).toBe(true);
  });

  it('reads reasons and queues decoded as byte arrays', () => {
    const bytes = delivery({
      headers: { 'x-death': [{ reason: Buffer.from('delivery_limit'), queue: Buffer.from('payments.work') }] },
    });
    expect(matches([{ kind: 'x-death-reason', value: 'delivery_limit' }], bytes)).toBe(true);
    expect(matches([{ kind: 'original-queue', value: 'payments.work' }], bytes)).toBe(true);
  });
});

describe('Died Again filter', () => {
  it('matches a Message carrying a replay id, as text or bytes', () => {
    expect(matches([{ kind: 'died-again' }], delivery({ headers: { 'x-volveran-replay-id': 'r1' } }))).toBe(true);
    expect(matches([{ kind: 'died-again' }], delivery({ headers: { 'x-volveran-replay-id': Buffer.from('r1') } }))).toBe(true);
    expect(matches([{ kind: 'died-again' }], delivery({ headers: { 'x-volveran-from': 'orders.dlq' } }))).toBe(false);
    expect(matches([{ kind: 'died-again' }], delivery())).toBe(false);
  });

  it('parses without a value', () => {
    expect(parseFilter([{ kind: 'died-again' }])).toEqual({ ok: true, filter: [{ kind: 'died-again' }] });
  });
});

describe('body text filter', () => {
  it('matches a case-insensitive substring of the body as sent', () => {
    const d = delivery({ body: '{"error":"Card DECLINED","order":42}', contentType: 'application/json' });
    expect(matches([{ kind: 'body-text', value: 'card declined' }], d)).toBe(true);
    // The raw body, not the pretty-printed view.
    expect(matches([{ kind: 'body-text', value: '"order":42' }], d)).toBe(true);
    expect(matches([{ kind: 'body-text', value: 'timeout' }], d)).toBe(false);
  });

  it('never matches bodies that are not UTF-8 text or are compressed', () => {
    expect(matches([{ kind: 'body-text', value: '(' }], delivery({ body: Buffer.from([0xc3, 0x28]) }))).toBe(false);
    expect(
      matches([{ kind: 'body-text', value: 'a' }], delivery({ body: 'abc', contentEncoding: 'gzip' })),
    ).toBe(false);
  });
});

describe('JSON path filter', () => {
  const order = delivery({
    contentType: 'application/json',
    body: JSON.stringify({
      order: { id: 'A-17', total: 42.5, paid: false, coupon: null, 'ship-to': { country: 'ES' } },
      items: [
        { sku: 'X1', qty: 1 },
        { sku: 'Y2', qty: 3 },
      ],
      tags: ['urgent', 'eu'],
    }),
  });
  const json = (path: string, value?: string) => matches([{ kind: 'json-path', path, value }], order);

  it('matches the value at a dotted path, with or without a leading $', () => {
    expect(json('order.id', 'A-17')).toBe(true);
    expect(json('$.order.id', 'A-17')).toBe(true);
    expect(json('order.id', 'A-18')).toBe(false);
  });

  it('compares numbers, booleans and null by their JSON text', () => {
    expect(json('order.total', '42.5')).toBe(true);
    expect(json('order.paid', 'false')).toBe(true);
    expect(json('order.coupon', 'null')).toBe(true);
    expect(json('order.total', '42')).toBe(false);
  });

  it('without a value, matches when the path exists, even holding null', () => {
    expect(json('order.coupon')).toBe(true);
    expect(json('order.ship-to')).toBe(true);
    expect(json('order.missing')).toBe(false);
    expect(json('order.id.deeper')).toBe(false);
  });

  it('never matches a value against an object or array', () => {
    expect(json('order', '*')).toBe(false);
    expect(json('tags', 'urgent')).toBe(false);
  });

  it('reads keys with special characters in brackets', () => {
    expect(json("order['ship-to'].country", 'ES')).toBe(true);
    expect(json('$["order"]["id"]', 'A-17')).toBe(true);
  });

  it('indexes arrays, counting from 0 and from the end with negative indexes', () => {
    expect(json('items[1].sku', 'Y2')).toBe(true);
    expect(json('items[0].sku', 'Y2')).toBe(false);
    expect(json('items[-1].qty', '3')).toBe(true);
    expect(json('tags[0]', 'urgent')).toBe(true);
    expect(json('items[5].sku')).toBe(false);
  });

  it('matches when any array element matches, with [*] or a key applied to the array', () => {
    expect(json('items[*].sku', 'Y2')).toBe(true);
    expect(json('items.sku', 'X1')).toBe(true);
    expect(json('tags[*]', 'eu')).toBe(true);
    expect(json('items[*].sku', 'Z9')).toBe(false);
  });

  it('matches against the whole body with $ alone', () => {
    const scalar = delivery({ body: '"hello"', contentType: 'application/json' });
    expect(matches([{ kind: 'json-path', path: '$', value: 'hello' }], scalar)).toBe(true);
  });

  it('never matches a body that is not JSON', () => {
    const notJson = (body: string | Buffer, contentEncoding?: string) =>
      matches([{ kind: 'json-path', path: 'order' }], delivery({ body, contentEncoding }));
    expect(notJson('order 42 failed')).toBe(false);
    expect(notJson('{"order": 1')).toBe(false);
    expect(notJson('')).toBe(false);
    expect(notJson(Buffer.from([0xff, 0x00]))).toBe(false);
    expect(notJson('{"order":1}', 'gzip')).toBe(false);
    // JSON without a content type still counts.
    expect(notJson('{"order":1}')).toBe(true);
  });
});

describe('combined filters', () => {
  const d = delivery({
    routingKey: 'orders.created',
    headers: { tenant: 'acme', 'x-death': [{ reason: 'rejected', queue: 'orders.work' }] },
    body: '{"order":{"id":"A-17"}}',
  });

  it('matches only when every clause matches', () => {
    const filter: Filter = [
      { kind: 'routing-key', value: 'orders.*' },
      { kind: 'header', name: 'tenant', value: 'acme' },
      { kind: 'x-death-reason', value: 'rejected' },
      { kind: 'original-queue', value: 'orders.work' },
      { kind: 'body-text', value: 'a-17' },
      { kind: 'json-path', path: 'order.id', value: 'A-17' },
    ];
    expect(matches(filter, d)).toBe(true);
    expect(matches([...filter, { kind: 'header', name: 'tenant', value: 'globex' }], d)).toBe(false);
  });

  it('matches every Message when empty', () => {
    expect(matches([], d)).toBe(true);
  });
});

describe('parseFilter', () => {
  it('reads a list of clauses, dropping an empty optional value', () => {
    expect(
      parseFilter([
        { kind: 'routing-key', value: 'orders.*' },
        { kind: 'header', name: 'tenant', value: '' },
        { kind: 'json-path', path: '$.order.id', value: 'A-17' },
      ]),
    ).toEqual({
      ok: true,
      filter: [
        { kind: 'routing-key', value: 'orders.*' },
        { kind: 'header', name: 'tenant' },
        { kind: 'json-path', path: '$.order.id', value: 'A-17' },
      ],
    });
  });

  it.each([
    ['not a list', { kind: 'routing-key', value: 'x' }, /list of clauses/],
    ['an unknown kind', [{ kind: 'priority', value: '1' }], /"priority" is not a filter clause;/],
    ['a clause without a kind', [{ value: 'x' }], /^A filter clause needs a "kind"; use one of routing-key, /],
    ['a clause that is not an object', ['routing-key'], /^A filter clause needs a "kind"/],
    ['a missing value', [{ kind: 'routing-key' }], /needs a "value"/],
    ['an empty required value', [{ kind: 'body-text', value: '' }], /needs a "value"/],
    ['a header without a name', [{ kind: 'header', value: 'x' }], /needs a header "name"/],
    ['a non-string optional value', [{ kind: 'header', name: 'a', value: 3 }], /"value" must be text/],
    ['a JSON path without a path', [{ kind: 'json-path' }], /needs a "path"/],
    ['a malformed JSON path', [{ kind: 'json-path', path: 'items[x]' }], /Invalid JSON path "items\[x\]"/],
    ['an unclosed bracket', [{ kind: 'json-path', path: "a['b" }], /Invalid JSON path/],
  ])('refuses %s', (_name, input, error) => {
    const result = parseFilter(input);
    expect(result.ok).toBe(false);
    expect(!result.ok && result.error).toMatch(error);
  });
});
