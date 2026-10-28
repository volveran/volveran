// NDJSON export of a Checkout through the HTTP API: one lossless JSON line
// per held Message, all of them or those matching a filter, recorded as an
// `export` Audit Entry. Exporting changes nothing: the Checkout keeps its
// Messages and Decisions, and the broker is checked independently over AMQP.
import type * as amqp from 'amqplib';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { fromAmqpJson } from '../../src/server/audit/amqp-json.js';
import {
  deadLetter,
  deadLetterRoutes,
  fixtureQueues,
  purgeQueues,
  readyMessageIds,
  startApp,
  testOperator,
  testProfile,
  withChannel,
  type TestApp,
} from './harness.js';

const checkoutPath = (queue: string) => `/api/profiles/local/vhosts/%2F/queues/${encodeURIComponent(queue)}/checkouts`;

/** Puts Messages straight onto `queue` (no dead-lettering), exactly as given. */
async function seed(queue: string, messages: Array<{ body: Buffer; options: amqp.Options.Publish }>) {
  await withChannel('/', async (ch) => {
    for (const m of messages) ch.sendToQueue(queue, m.body, m.options);
    await ch.waitForConfirms();
  });
}

/** POSTs an export; the raw response, so a test can read it as a stream. */
function postExport(app: TestApp, id: string, body: unknown = {}): Promise<Response> {
  return fetch(`${app.baseUrl}/api/checkouts/${id}/export`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

/** Every line of an NDJSON response, parsed. */
async function exportLines(res: Response): Promise<any[]> {
  const text = await res.text();
  expect(text.endsWith('\n')).toBe(true);
  return text
    .slice(0, -1)
    .split('\n')
    .map((line) => JSON.parse(line));
}

const published = [
  {
    body: Buffer.from(JSON.stringify({ order: { id: 'A-1' }, error: 'card declined' })),
    options: {
      messageId: 'a',
      contentType: 'application/json',
      correlationId: 'corr-1',
      appId: 'orders',
      type: 'order.created',
      priority: 3,
      timestamp: 1_700_000_000,
      persistent: true,
      headers: {
        tenant: 'acme',
        attempt: 2,
        ratio: 0.5,
        retry: true,
        raw: Buffer.from([0, 1, 2, 254, 255]),
        nested: { $weird: 'key', list: ['x', 7] },
      },
    },
  },
  { body: Buffer.from('plain text, not JSON'), options: { messageId: 'b', contentType: 'text/plain', headers: { tenant: 'globex' } } },
  { body: Buffer.from([0xde, 0xad, 0xbe, 0xef, 0x00, 0xff]), options: { messageId: 'c', headers: { tenant: 'acme' } } },
] satisfies Array<{ body: Buffer; options: amqp.Options.Publish }>;

describe('NDJSON export of a Checkout', () => {
  let app: TestApp;
  const open: string[] = [];

  async function startCheckout(queue = 'orders.dlq') {
    const res = await app.post(checkoutPath(queue));
    expect(res.status).toBe(201);
    open.push(res.body.checkout.id);
    return res.body.checkout;
  }

  beforeAll(async () => {
    app = await startApp({ profiles: [testProfile({ name: 'local' })] });
  });
  afterEach(async () => {
    while (open.length) await app.delete(`/api/checkouts/${open.pop()}`);
    await purgeQueues('/', fixtureQueues);
  });
  afterAll(async () => {
    await app?.close();
  });

  it('streams one line per held Message, in queue order, that round-trips byte for byte', async () => {
    await seed('orders.dlq', published);
    const checkout = await startCheckout();

    const res = await postExport(app, checkout.id);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/^application\/x-ndjson/);
    expect(res.headers.get('content-disposition')).toMatch(
      /^attachment; filename="volveran-local-orders\.dlq-\d{8}T\d{6}Z\.ndjson"$/,
    );
    const lines = await exportLines(res);

    expect(lines.map((l) => [l.v, l.position, l.messageId])).toEqual([
      [1, 1, 'a'],
      [1, 2, 'b'],
      [1, 3, 'c'],
    ]);
    for (const [i, line] of lines.entries()) {
      const sent = published[i]!;
      expect(Buffer.from(line.body, 'base64')).toEqual(sent.body);
      const { headers, persistent: _persistent, ...properties } = sent.options as amqp.Options.Publish;
      expect(fromAmqpJson(line.headers)).toEqual(headers);
      expect(fromAmqpJson(line.properties)).toEqual({ ...properties, deliveryMode: i === 0 ? 2 : undefined });
    }
    expect(lines.map((l) => l.bodyKind)).toEqual(['json', 'text', 'binary']);
    expect(lines[0].headers.raw).toEqual({ $bytes: Buffer.from([0, 1, 2, 254, 255]).toString('base64') });
    expect(lines[0]).toMatchObject({ exchange: '', routingKey: 'orders.dlq', xDeath: [], deliveryBudget: null });
    expect(lines.every((l) => l.decision.kind === 'keep' && l.diedAgain === null)).toBe(true);
  });

  it('exports only the Messages matching a filter, with their Decisions, and changes nothing', async () => {
    await deadLetter(deadLetterRoutes.classic, [
      { body: '{"n":1}', options: { messageId: 'a', contentType: 'application/json', headers: { tenant: 'acme' } } },
      { body: '{"n":2}', options: { messageId: 'b', contentType: 'application/json', headers: { tenant: 'globex' } } },
      { body: '{"n":3}', options: { messageId: 'c', contentType: 'application/json', headers: { tenant: 'acme' } } },
    ]);
    const checkout = await startCheckout();
    const handle = (id: string) => checkout.messages.find((m: any) => m.messageId === id).handle;
    await app.post(`/api/checkouts/${checkout.id}/decisions`, { handles: [handle('a')], decision: { kind: 'discard', reason: 'bad' } });
    await app.post(`/api/checkouts/${checkout.id}/decisions`, {
      handles: [handle('c')],
      decision: { kind: 'move', destination: { queue: 'triage.manual' } },
    });
    const before = (await app.get(`/api/checkouts/${checkout.id}`)).body.checkout;

    const filter = [{ kind: 'header', name: 'tenant', value: 'acme' }];
    const res = await postExport(app, checkout.id, { filter });
    expect(res.status).toBe(200);
    const lines = await exportLines(res);

    expect(lines.map((l) => [l.position, l.messageId, l.decision])).toEqual([
      [1, 'a', { kind: 'discard', reason: 'bad' }],
      [3, 'c', { kind: 'move', destination: { queue: 'triage.manual' } }],
    ]);
    expect(lines[0].xDeath).toEqual([
      expect.objectContaining({ queue: 'orders.work', reason: 'rejected', count: 1, exchange: 'orders' }),
    ]);

    // The Checkout still holds every Message, with the same Decisions; the broker has none back.
    const after = (await app.get(`/api/checkouts/${checkout.id}`)).body.checkout;
    expect(after).toMatchObject({ status: 'active', heldCount: 3 });
    expect(after.messages).toEqual(before.messages);
    expect(await readyMessageIds('/', 'orders.dlq')).toEqual([]);

    // Ending it returns them in their original order.
    await app.delete(`/api/checkouts/${open.pop()}`);
    expect(await readyMessageIds('/', 'orders.dlq')).toEqual(['a', 'b', 'c']);
  });

  it('records each export as an Audit Entry with the filter and count, found by the audit search', async () => {
    await seed('orders.dlq', published);
    const checkout = await startCheckout();
    const filter = [{ kind: 'header', name: 'tenant', value: 'acme' }];

    await (await postExport(app, checkout.id, { filter })).text();
    await (await postExport(app, checkout.id)).text();

    const { entries } = (await app.get(`/api/audit-entries?action=export&checkoutId=${checkout.id}`)).body;
    expect(entries).toEqual([
      expect.objectContaining({ action: 'export', filter: null, messageCount: 3, outcome: 'done' }),
      expect.objectContaining({ action: 'export', filter, messageCount: 2, outcome: 'done' }),
    ]);
    expect(entries[0]).toMatchObject({
      operatorName: testOperator,
      profile: 'local',
      vhost: '/',
      queue: 'orders.dlq',
      checkoutId: checkout.id,
      messageId: null,
      message: null,
    });
  });

  it('refuses an ended Checkout with 409 checkout_not_active', async () => {
    await seed('orders.dlq', published);
    const checkout = await startCheckout();
    await app.delete(`/api/checkouts/${open.pop()}`);

    const res = await postExport(app, checkout.id);
    expect(res.status).toBe(409);
    expect((await res.json()).error.code).toBe('checkout_not_active');
    expect((await app.get(`/api/audit-entries?action=export&checkoutId=${checkout.id}`)).body.entries).toEqual([]);
  });

  it('refuses a filter that is not one', async () => {
    await seed('orders.dlq', published);
    const checkout = await startCheckout();
    const res = await postExport(app, checkout.id, { filter: [{ kind: 'nope' }] });
    expect(res.status).toBe(400);
  });
});

describe('NDJSON export of a Checkout near the byte limit', () => {
  const count = 90;
  const size = 1024 * 1024;
  let app: TestApp;
  let made = 0;
  let checkoutId: string | undefined;

  beforeAll(async () => {
    app = await startApp({
      profiles: [testProfile({ name: 'local' })],
      checkoutLimits: { maxBytes: 100 * 1024 * 1024 },
      checkoutTestHooks: {
        beforeExportLine: async () => {
          made++;
        },
      },
    });
  });
  afterAll(async () => {
    if (checkoutId) await app.delete(`/api/checkouts/${checkoutId}`);
    await purgeQueues('/', fixtureQueues);
    await app?.close();
  });

  it('streams the lines as they are read instead of making them all first', async () => {
    await withChannel('/', async (ch) => {
      for (let i = 0; i < count; i++) {
        ch.sendToQueue('orders.dlq', Buffer.alloc(size, i), { messageId: `m${i}` });
        await ch.waitForConfirms();
      }
    });
    const started = await app.post(checkoutPath('orders.dlq'));
    expect(started.status).toBe(201);
    checkoutId = started.body.checkout.id;
    expect(started.body.checkout).toMatchObject({ heldCount: count, limitedBy: null });

    const res = await postExport(app, checkoutId!);
    expect(res.status).toBe(200);
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let text = decoder.decode((await reader.read()).value, { stream: true });
    // The reader stalls: the server stops making lines once the socket is full.
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(made).toBeLessThan(count / 2);

    // Reads the rest a line at a time, never keeping the whole download.
    const positions: number[] = [];
    for (;;) {
      let nl: number;
      while ((nl = text.indexOf('\n')) !== -1) {
        const line = JSON.parse(text.slice(0, nl));
        text = text.slice(nl + 1);
        expect(Buffer.from(line.body, 'base64')).toEqual(Buffer.alloc(size, line.position - 1));
        positions.push(line.position);
      }
      const { done, value } = await reader.read();
      if (done) break;
      text += decoder.decode(value, { stream: true });
    }
    expect(positions).toEqual(Array.from({ length: count }, (_, i) => i + 1));
    expect(made).toBe(count);
  }, 120_000);
});
