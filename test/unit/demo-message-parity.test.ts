// The demo's Message view and filters (site/demo/api/simulator/message-view.ts
// and filters.ts) are Buffer-free mirrors of the server's
// (src/server/triage/message-view.ts and filters.ts): on the same Messages,
// both give the same view, read the same filters and match the same ones. The
// Messages are every one the demo's broker holds at the start, as seed.mjs
// dead-letters them, plus a few made to reach the corners.
import { describe, expect, it } from 'vitest';
import { scenarioBroker, SCENARIO_TOPOLOGY, type BrokerMessage, type QueueSpec } from '../../site/demo/api/simulator/broker.js';
import { matchesFilter as demoMatches, parseFilter as demoParse } from '../../site/demo/api/simulator/filters.js';
import { messageDetail as demoDetail, messageSummary as demoSummary, type QueueInfo } from '../../site/demo/api/simulator/message-view.js';
import { matchesFilter as serverMatches, parseFilter as serverParse } from '../../src/server/triage/filters.js';
import { messageDetail as serverDetail, messageSummary as serverSummary, type Delivery } from '../../src/server/triage/message-view.js';
import type { Filter } from '../../src/shared/filters.js';

const at = new Date('2026-10-29T06:23:20.000Z');

function queueInfo(q: QueueSpec): QueueInfo {
  return { type: q.type === 'stream' ? 'classic' : q.type, deliveryLimit: q.deliveryLimit ?? null, deadLetterExchange: q.deadLetterExchange !== undefined };
}

/** The same Message as amqplib hands it to the server. */
function delivery(m: BrokerMessage): Delivery {
  return {
    fields: { exchange: m.exchange, routingKey: m.routingKey, redelivered: m.redelivered },
    properties: structuredClone(m.properties),
    content: Buffer.from(m.content),
  };
}

const encode = (text: string) => new TextEncoder().encode(text);

const made: BrokerMessage[] = [
  {
    exchange: 'orders',
    routingKey: 'orders.created.eu',
    redelivered: true,
    properties: {
      messageId: 'made-binary',
      contentType: 'application/octet-stream',
      timestamp: 1_793_000_000,
      headers: { 'x-delivery-count': 3, 'x-tenant': 'south', flag: true, n: 7, 'x-death': 'not a list' },
    },
    content: Uint8Array.from([0x0a, 0x08, 0xd2, 0x09, 0x10, 0xff, 0x00]),
  },
  {
    exchange: '',
    routingKey: 'orders.work',
    redelivered: false,
    properties: {
      messageId: 'made-spring',
      contentType: 'application/json',
      headers: {
        'x-exception-message': 'Could not acquire JDBC connection; SQLTimeoutException: Connection is not available, request timed out after 30000ms.',
        'x-exception-stacktrace': 'org.springframework.jdbc.CannotGetJdbcConnectionException: Could not acquire JDBC connection\n\tat x.y(Z.java:1)',
        'x-original-exchange': '',
        'x-original-routingKey': 'orders.work',
        'x-volveran-replay-id': 'r-1',
      },
    },
    content: encode('{"order":{"id":"o-1","lines":[{"sku":"a","qty":2},{"sku":"b","qty":1}]},"note":null}'),
  },
  {
    exchange: 'orders',
    routingKey: 'orders.created.us',
    redelivered: false,
    properties: { contentType: 'text/plain', headers: { 'x-volveran-replay-id': '' } },
    content: encode('Plain text body, Order O-2'),
  },
];

const held: Array<{ message: BrokerMessage; info: QueueInfo }> = (() => {
  const broker = scenarioBroker(at);
  const found = SCENARIO_TOPOLOGY.queues.flatMap((q) =>
    broker.hold({ vhost: q.vhost, queue: q.name }, Infinity).map((message) => ({ message, info: queueInfo(q) })),
  );
  const orders = queueInfo(SCENARIO_TOPOLOGY.queues.find((q) => q.name === 'orders.dlq')!);
  const quorum = queueInfo(SCENARIO_TOPOLOGY.queues.find((q) => q.type === 'quorum')!);
  return [...found, ...made.map((message, i) => ({ message, info: i === 0 ? quorum : orders }))];
})();

describe("the demo's Message view", () => {
  it('holds Messages of every kind the scenario seeds', () => {
    expect(held.length).toBeGreaterThan(20);
    expect(held.some(({ message }) => message.properties.headers?.['x-exception-message'] !== undefined)).toBe(true);
  });

  it.each(held.map((h, i) => [h.message.properties.messageId ?? `#${i}`, h] as const))("gives the server's summary and detail for %s", (_id, { message, info }) => {
    expect(demoSummary(1, message, info)).toEqual(serverSummary(1, delivery(message), info));
    expect(demoDetail(1, message, info)).toEqual(serverDetail(1, delivery(message), info));
  });
});

const inputs: unknown[] = [
  [],
  [{ kind: 'routing-key', value: 'orders.*' }],
  [{ kind: 'routing-key', value: 'orders.created.??' }],
  [{ kind: 'header', name: 'x-tenant' }],
  [{ kind: 'header', name: 'x-tenant', value: 's*' }],
  [{ kind: 'header', name: 'n', value: '7' }],
  [{ kind: 'header', name: 'flag', value: 'true' }],
  [{ kind: 'x-death-reason', value: 'rejected' }],
  [{ kind: 'x-death-reason', value: 'expired' }],
  [{ kind: 'original-queue', value: 'orders.*' }],
  [{ kind: 'original-queue', value: 'payments.work' }],
  [{ kind: 'body-text', value: 'order' }],
  [{ kind: 'body-text', value: 'O-2' }],
  [{ kind: 'json-path', path: '$.order.id' }],
  [{ kind: 'json-path', path: '$.order.lines[*].sku', value: 'b' }],
  [{ kind: 'json-path', path: "$['order'].lines[-1].qty", value: '1' }],
  [{ kind: 'json-path', path: '$.note', value: 'null' }],
  [{ kind: 'json-path', path: '$.*' }],
  [{ kind: 'failure', value: 'SQLTimeoutException' }],
  [{ kind: 'failure', value: 'cannotgetjdbc' }],
  [{ kind: 'died-again' }],
  [{ kind: 'routing-key', value: 'orders.*' }, { kind: 'failure', value: 'timeout' }],
  // Refused, with the server's reasons.
  {},
  [{ kind: 'nope' }],
  [{ value: 'x' }],
  [{ kind: 'routing-key' }],
  [{ kind: 'header' }],
  [{ kind: 'header', name: 'x', value: 3 }],
  [{ kind: 'json-path' }],
  [{ kind: 'json-path', path: '$.a[' }],
  [{ kind: 'json-path', path: '$.a[x]' }],
  [{ kind: 'json-path', path: "$['a" }],
  [{ kind: 'json-path', path: '$..a' }],
  [{ kind: 'routing-key', value: 'a' }, 'not a clause'],
];

describe("the demo's filters", () => {
  it.each(inputs.map((input) => [JSON.stringify(input), input] as const))('reads %s as the server does', (_text, input) => {
    expect(demoParse(input)).toEqual(serverParse(input));
  });

  const filters = inputs
    .map((input) => serverParse(input))
    .filter((p): p is { ok: true; filter: Filter } => p.ok)
    .map((p) => [JSON.stringify(p.filter), p.filter] as const);

  it.each(filters)('matches the Messages the server matches with %s', (_text, filter) => {
    const demo = held.map(({ message }) => demoMatches(filter, message));
    expect(demo).toEqual(held.map(({ message }) => serverMatches(filter, delivery(message))));
  });

  it('matches some Messages and not others with most filters, so the comparison means something', () => {
    const mixed = filters.filter(([, filter]) => {
      const results = new Set(held.map(({ message }) => serverMatches(filter, delivery(message))));
      return results.size === 2;
    });
    expect(mixed.length).toBeGreaterThan(filters.length / 2);
  });
});
