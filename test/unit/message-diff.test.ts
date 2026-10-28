// The Message diff: two Message views compared property by property, header
// by header, x-death entry by position, Failure Details by field and the body
// by kind.
import { describe, expect, it } from 'vitest';
import { diffMessages, type ComparableMessage } from '../../src/server/triage/message-diff.js';

/** A Message view with an empty JSON body, overridden per test. */
function message(over: Partial<ComparableMessage> = {}): ComparableMessage {
  return { properties: {}, headers: {}, xDeath: [], body: { kind: 'json', size: 2, text: '{}' }, ...over };
}

const json = (value: unknown) => {
  const text = JSON.stringify(value, null, 2);
  return { kind: 'json' as const, size: text.length, text };
};

describe('diffMessages: headers and properties', () => {
  it('lines headers up by name, including headers on one side only', () => {
    const diff = diffMessages(
      message({ headers: { tenant: 'acme', retries: 1, trace: 'abc' } }),
      message({ headers: { tenant: 'acme', retries: 2, region: 'eu' } }),
    );
    expect(diff.headers).toEqual([
      { name: 'region', status: 'onlyRight', right: 'eu' },
      { name: 'retries', status: 'changed', left: 1, right: 2 },
      { name: 'tenant', status: 'equal', left: 'acme', right: 'acme' },
      { name: 'trace', status: 'onlyLeft', left: 'abc' },
    ]);
  });
});

describe('diffMessages: x-death', () => {
  const entry = (queue: string, reason: string, count: number) => ({
    queue,
    reason,
    count,
    time: '2026-10-16T08:32:37.000Z',
    exchange: 'orders',
    routingKeys: ['orders.created'],
    originalExpiration: null,
  });

  it('compares x-death entries by position and leaves the raw header out of the headers', () => {
    const left = [entry('orders.work', 'rejected', 2), entry('orders.retry', 'expired', 1)];
    const right = [entry('orders.work', 'rejected', 3)];
    const diff = diffMessages(
      message({ headers: { 'x-death': ['left'] }, xDeath: left }),
      message({ headers: { 'x-death': ['right'] }, xDeath: right }),
    );
    expect(diff.headers).toEqual([]);
    expect(diff.xDeath.map((x) => [x.position, x.status])).toEqual([
      [0, 'changed'],
      [1, 'onlyLeft'],
    ]);
    expect(diff.xDeath[0]!.fields.filter((f) => f.status !== 'equal')).toEqual([
      { name: 'count', status: 'changed', left: 2, right: 3 },
    ]);
    expect(diff.xDeath[1]!.fields).toContainEqual({ name: 'queue', status: 'onlyLeft', left: 'orders.retry' });
  });

  it('marks identical entries equal', () => {
    const same = [entry('orders.work', 'rejected', 1)];
    expect(diffMessages(message({ xDeath: same }), message({ xDeath: same })).xDeath).toMatchObject([
      { position: 0, status: 'equal' },
    ]);
  });
});

describe('diffMessages: Failure Details', () => {
  const spring = { framework: 'spring', exceptionType: 'java.lang.IllegalStateException', message: 'no stock', stackTrace: null };

  it('compares Failure Details field by field', () => {
    const diff = diffMessages(
      message({ failureDetails: spring }),
      message({ failureDetails: { ...spring, message: 'no price' } }),
    );
    expect(diff.failureDetails).toEqual([
      { name: 'exceptionType', status: 'equal', left: spring.exceptionType, right: spring.exceptionType },
      { name: 'framework', status: 'equal', left: 'spring', right: 'spring' },
      { name: 'message', status: 'changed', left: 'no stock', right: 'no price' },
      { name: 'stackTrace', status: 'equal', left: null, right: null },
    ]);
  });

  it('shows the fields of the one Message that has them as on its side only', () => {
    const diff = diffMessages(message({ failureDetails: null }), message({ failureDetails: spring }));
    expect(diff.failureDetails).toContainEqual({ name: 'message', status: 'onlyRight', right: 'no stock' });
    expect(diff.failureDetails?.every((f) => f.status === 'onlyRight')).toBe(true);
  });

  it('is null when neither Message has Failure Details', () => {
    expect(diffMessages(message(), message({ failureDetails: null })).failureDetails).toBeNull();
  });
});

describe('diffMessages: JSON bodies', () => {
  const bodyDiff = (left: unknown, right: unknown) =>
    diffMessages(message({ body: json(left) }), message({ body: json(right) })).body;
  const changes = (left: unknown, right: unknown) => {
    const diff = bodyDiff(left, right);
    if (diff.kind !== 'json') throw new Error(`a ${diff.kind} diff`);
    return diff.changes;
  };

  it('lists changes in nested objects by JSON path', () => {
    expect(
      bodyDiff(
        { order: { id: 7, customer: { name: 'Ada', tier: 'gold' } }, source: 'web' },
        { order: { id: 7, customer: { name: 'Ada', email: 'ada@example.com' } }, source: 'app' },
      ),
    ).toEqual({
      kind: 'json',
      equal: false,
      changes: [
        { path: '$.order.customer.tier', status: 'onlyLeft', left: 'gold' },
        { path: '$.order.customer.email', status: 'onlyRight', right: 'ada@example.com' },
        { path: '$.source', status: 'changed', left: 'web', right: 'app' },
      ],
    });
  });

  it('compares arrays by index', () => {
    expect(bodyDiff({ items: [{ sku: 'a' }, { sku: 'b' }, { sku: 'c' }] }, { items: [{ sku: 'a' }, { sku: 'x' }] })).toEqual({
      kind: 'json',
      equal: false,
      changes: [
        { path: '$.items[1].sku', status: 'changed', left: 'b', right: 'x' },
        { path: '$.items[2]', status: 'onlyLeft', left: { sku: 'c' } },
      ],
    });
  });

  it('reports a change of type at its path without looking inside', () => {
    expect(changes({ a: 1, b: { c: 1 }, d: [1], e: null }, { a: '1', b: [1], d: { 0: 1 }, e: {} })).toEqual([
      { path: '$.a', status: 'changed', left: 1, right: '1' },
      { path: '$.b', status: 'changed', left: { c: 1 }, right: [1] },
      { path: '$.d', status: 'changed', left: [1], right: { 0: 1 } },
      { path: '$.e', status: 'changed', left: null, right: {} },
    ]);
  });

  it('quotes keys that are not plain names, and compares top-level values', () => {
    expect(changes({ 'order id': 1, 'é': 2 }, { 'order id': 2, 'é': 2 })).toEqual([
      { path: '$["order id"]', status: 'changed', left: 1, right: 2 },
    ]);
    expect(bodyDiff([1, 2], [1, 2])).toEqual({ kind: 'json', equal: true, changes: [] });
    expect(changes(1, 2)).toEqual([{ path: '$', status: 'changed', left: 1, right: 2 }]);
  });
});

describe('diffMessages: text bodies', () => {
  const text = (t: string) => ({ kind: 'text' as const, size: t.length, text: t });
  const bodyDiff = (left: string, right: string) =>
    diffMessages(message({ body: text(left) }), message({ body: text(right) })).body;

  it('groups changed, removed and added lines into hunks', () => {
    const left = ['<order>', '  <id>7</id>', '  <sku>a</sku>', '  <qty>1</qty>', '  <note>x</note>', '</order>'].join('\n');
    const right = ['<order>', '  <id>8</id>', '  <sku>a</sku>', '  <qty>1</qty>', '  <gift/>', '  <note>x</note>', '</order>'].join('\n');
    expect(bodyDiff(left, right)).toEqual({
      kind: 'text',
      equal: false,
      hunks: [
        { leftStart: 2, leftLines: ['  <id>7</id>'], rightStart: 2, rightLines: ['  <id>8</id>'] },
        { leftStart: 5, leftLines: [], rightStart: 5, rightLines: ['  <gift/>'] },
      ],
    });
    expect(bodyDiff('a\nb\nc', 'a\nc')).toMatchObject({
      hunks: [{ leftStart: 2, leftLines: ['b'], rightStart: 2, rightLines: [] }],
    });
  });

  it('has no hunks for equal text', () => {
    expect(bodyDiff('same\ntext', 'same\ntext')).toEqual({ kind: 'text', equal: true, hunks: [] });
  });

  it('still answers for long, entirely different texts', () => {
    const lines = (prefix: string) => Array.from({ length: 20_000 }, (_, i) => `${prefix}${i}`).join('\n');
    const diff = bodyDiff(lines('a'), lines('b'));
    expect(diff).toMatchObject({ kind: 'text', equal: false });
    if (diff.kind !== 'text') throw new Error('not text');
    expect(diff.hunks.flatMap((h) => h.leftLines)).toHaveLength(20_000);
    expect(diff.hunks.flatMap((h) => h.rightLines)).toHaveLength(20_000);
  });
});

describe('diffMessages: binary bodies and bodies of different kinds', () => {
  const binary = (bytes: number[]) => {
    const b = Buffer.from(bytes);
    return { kind: 'binary' as const, size: b.length, hex: b.toString('hex'), base64: b.toString('base64') };
  };
  const bodyDiff = (left: ComparableMessage['body'], right: ComparableMessage['body']) =>
    diffMessages(message({ body: left }), message({ body: right })).body;

  it('gives the sizes and the first byte that differs', () => {
    expect(bodyDiff(binary([0, 1, 2, 3]), binary([0, 1, 9, 3]))).toEqual({
      kind: 'binary',
      equal: false,
      leftSize: 4,
      rightSize: 4,
      firstDifferentByte: 2,
    });
    // One body is the start of the other: they differ from the end of the shorter one.
    expect(bodyDiff(binary([0, 1]), binary([0, 1, 2]))).toMatchObject({ leftSize: 2, rightSize: 3, firstDifferentByte: 2 });
    expect(bodyDiff(binary([255, 0]), binary([255, 0]))).toEqual({
      kind: 'binary',
      equal: true,
      leftSize: 2,
      rightSize: 2,
      firstDifferentByte: null,
    });
  });

  it('says only that bodies of different kinds differ', () => {
    expect(bodyDiff(json({ a: 1 }), { kind: 'text', size: 3, text: 'a=1' })).toEqual({
      kind: 'mixed',
      equal: false,
      leftKind: 'json',
      rightKind: 'text',
    });
    expect(bodyDiff(binary([0]), json([]))).toMatchObject({ kind: 'mixed', leftKind: 'binary', rightKind: 'json' });
  });
});
