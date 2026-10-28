// Comparing two held Messages through the HTTP API: Messages published with
// known differences give the expected diff, and the handles are checked.
// Who may compare (owner, approver, Role) is covered with the Message view
// in team-mode, roles and approval tests.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { purgeQueues, startApp, testProfile, withChannel, type TestApp } from './harness.js';

const QUEUE = 'compare.dlq';

describe('Comparing two Messages', () => {
  let app: TestApp;
  let id: string;
  /** Handle by message id. */
  let handles: Record<string, number>;

  beforeAll(async () => {
    await withChannel('/', async (ch) => {
      await ch.assertQueue(QUEUE, { durable: true });
      const json = (messageId: string, headers: Record<string, unknown>, body: unknown) =>
        ch.sendToQueue(QUEUE, Buffer.from(JSON.stringify(body)), { messageId, contentType: 'application/json', headers });
      json('json-a', { tenant: 'acme', attempt: 1, trace: 't-1' }, { order: { id: 7, items: [{ sku: 'a' }, { sku: 'b' }] }, note: 'x' });
      json('json-b', { tenant: 'acme', attempt: 2, region: 'eu' }, { order: { id: 7, items: [{ sku: 'a' }, { sku: 'c' }] } });
      const text = (messageId: string, body: string) =>
        ch.sendToQueue(QUEUE, Buffer.from(body), { messageId, contentType: 'text/plain' });
      text('text-a', 'line 1\nline 2\nline 3');
      text('text-b', 'line 1\nline two\nline 3\nline 4');
      ch.sendToQueue(QUEUE, Buffer.from([0, 1, 2, 3]), { messageId: 'bin-a' });
      ch.sendToQueue(QUEUE, Buffer.from([0, 1, 9]), { messageId: 'bin-b' });
      await ch.waitForConfirms();
    });
    app = await startApp({ profiles: [testProfile({ name: 'local' })] });
    const started = await app.post(`/api/profiles/local/vhosts/%2F/queues/${QUEUE}/checkouts`);
    expect(started.status).toBe(201);
    id = started.body.checkout.id;
    handles = Object.fromEntries(started.body.checkout.messages.map((m: any) => [m.messageId, m.handle]));
  });
  afterAll(async () => {
    if (id) await app.delete(`/api/checkouts/${id}`);
    await app?.close();
    await purgeQueues('/', [QUEUE]);
    await withChannel('/', (ch) => ch.deleteQueue(QUEUE));
  });

  const compare = (a: unknown, b: unknown) => app.get(`/api/checkouts/${id}/compare?a=${a}&b=${b}`);

  it('answers both Message views and the diff of their headers, properties and JSON bodies', async () => {
    const res = await compare(handles['json-a'], handles['json-b']);
    expect(res.status).toBe(200);
    const { left, right, diff } = res.body;
    expect([left.messageId, right.messageId]).toEqual(['json-a', 'json-b']);
    expect(diff.headers).toEqual([
      { name: 'attempt', status: 'changed', left: 1, right: 2 },
      { name: 'region', status: 'onlyRight', right: 'eu' },
      { name: 'tenant', status: 'equal', left: 'acme', right: 'acme' },
      { name: 'trace', status: 'onlyLeft', left: 't-1' },
    ]);
    expect(diff.properties).toContainEqual({ name: 'messageId', status: 'changed', left: 'json-a', right: 'json-b' });
    expect(diff.properties).toContainEqual({
      name: 'contentType',
      status: 'equal',
      left: 'application/json',
      right: 'application/json',
    });
    expect(diff.xDeath).toEqual([]);
    expect(diff.failureDetails).toBeNull();
    expect(diff.body).toEqual({
      kind: 'json',
      equal: false,
      changes: [
        { path: '$.order.items[1].sku', status: 'changed', left: 'b', right: 'c' },
        { path: '$.note', status: 'onlyLeft', left: 'x' },
      ],
    });
  });

  it('compares text bodies line by line and binary bodies by size and first differing byte', async () => {
    expect((await compare(handles['text-a'], handles['text-b'])).body.diff.body).toEqual({
      kind: 'text',
      equal: false,
      hunks: [
        { leftStart: 2, leftLines: ['line 2'], rightStart: 2, rightLines: ['line two'] },
        { leftStart: 4, leftLines: [], rightStart: 4, rightLines: ['line 4'] },
      ],
    });
    expect((await compare(handles['bin-a'], handles['bin-b'])).body.diff.body).toEqual({
      kind: 'binary',
      equal: false,
      leftSize: 4,
      rightSize: 3,
      firstDifferentByte: 2,
    });
    expect((await compare(handles['json-a'], handles['text-a'])).body.diff.body).toEqual({
      kind: 'mixed',
      equal: false,
      leftKind: 'json',
      rightKind: 'text',
    });
  });

  it('answers 404 for an unknown handle and 400 for the same handle twice or a missing one', async () => {
    const unknown = await compare(handles['json-a'], 999);
    expect([unknown.status, unknown.body.error.code]).toEqual([404, 'message_not_found']);
    expect((await compare('abc', handles['json-a'])).status).toBe(404);
    const same = await compare(handles['json-a'], handles['json-a']);
    expect([same.status, same.body.error.code]).toEqual([400, 'invalid_request']);
    const missing = await app.get(`/api/checkouts/${id}/compare?a=${handles['json-a']}`);
    expect([missing.status, missing.body.error.code]).toEqual([400, 'invalid_request']);
  });
});
