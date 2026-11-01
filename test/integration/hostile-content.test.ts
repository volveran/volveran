// Anyone who can publish to a queue chooses a Message's body, headers and routing key, and
// anyone who can declare one chooses a queue's name (#124). None of it may become markup in
// an Operator's browser. There is no browser here (#92, Testing Decisions), so this proves it
// in the two steps a browser would rely on: the server's answers can only be read as data,
// and the web app's own components, given those answers, write the content as text.
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { QueueTable } from '../../src/web/App.js';
import { MessageDetailView, MessageList } from '../../src/web/MessageList.js';
import { startApp, testProfile, withChannel, type TestApp } from './harness.js';

const IN_QUEUE_NAME = '<img src=x onerror=alert(1)>.dlq';
const IN_BODY = '<script>alert("body")</script>';
const IN_HEADER = '<svg onload=alert("header")>';
const IN_ROUTING_KEY = '<iframe src="javascript:alert(1)">';
const IN_MESSAGE_ID = '<a href="javascript:alert(1)">id</a>';
/** The tags in the payloads. Each may reach the page only escaped. */
const FORBIDDEN_TAGS = /<(script|img|svg|iframe)\b|<a [^>]*href="javascript:/i;

const encodedQueue = encodeURIComponent(IN_QUEUE_NAME);
const startPath = `/api/profiles/local/vhosts/%2F/queues/${encodedQueue}/checkouts`;

/** As the markup appears in a page when written as text. */
const asText = (markup: string) => markup.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');

describe('hostile Message content', () => {
  let app: TestApp;
  let checkoutId: string;
  let row: any;

  const read = async (urlPath: string) => {
    const res = await fetch(app.baseUrl + urlPath);
    expect(res.status, urlPath).toBe(200);
    return res;
  };
  const expectOnlyData = (res: Response, label: string) => {
    expect(res.headers.get('content-type'), label).toMatch(/^application\/(json|x-ndjson)/);
    expect(res.headers.get('x-content-type-options'), label).toBe('nosniff');
    expect(res.headers.get('content-security-policy'), label).toContain("default-src 'none'");
  };

  beforeAll(async () => {
    await withChannel('/', async (ch) => {
      await ch.deleteQueue(IN_QUEUE_NAME);
      await ch.assertQueue(IN_QUEUE_NAME, { durable: true });
      await ch.bindQueue(IN_QUEUE_NAME, 'amq.topic', '#');
      ch.publish('amq.topic', IN_ROUTING_KEY, Buffer.from(IN_BODY), {
        // A sender claiming HTML must not get its body served as HTML.
        contentType: 'text/html',
        messageId: IN_MESSAGE_ID,
        headers: { [IN_HEADER]: IN_HEADER },
      });
      await ch.waitForConfirms();
    });
    app = await startApp({ profiles: [testProfile({ name: 'local' })] });
    const started = await app.post(startPath, {});
    expect(started.status).toBe(201);
    checkoutId = started.body.checkout.id;
    row = started.body.checkout.messages[0];
  });
  afterAll(async () => {
    if (checkoutId) await app.post(`/api/checkouts/${checkoutId}/end`);
    await app?.close();
    await withChannel('/', async (ch) => {
      await ch.deleteQueue(IN_QUEUE_NAME);
    });
  });

  it('reaches the Operator unchanged, as it was sent', async () => {
    expect(row.routingKey).toBe(IN_ROUTING_KEY);
    const { message } = await (await read(`/api/checkouts/${checkoutId}/messages/${row.handle}`)).json();
    expect(message.messageId).toBe(IN_MESSAGE_ID);
    expect(message.body.text).toBe(IN_BODY);
    expect(message.headers[IN_HEADER]).toBe(IN_HEADER);
  });

  it('comes back only in answers a browser reads as data', async () => {
    const paths = [
      '/api/profiles/local/vhosts/%2F/queues',
      '/api/profiles/local/vhosts/%2F/dead-letter-map',
      `/api/checkouts/${checkoutId}`,
      `/api/checkouts/${checkoutId}/messages/${row.handle}`,
      `/api/audit-entries?queue=${encodedQueue}`,
    ];
    for (const urlPath of paths) expectOnlyData(await read(urlPath), urlPath);

    const unknown = await fetch(`${app.baseUrl}/api/${encodeURIComponent(IN_BODY)}`);
    expect(unknown.status).toBe(404);
    expectOnlyData(unknown, 'an unknown API path naming the markup');
  });

  it('is exported as a download of NDJSON, under a harmless file name', async () => {
    const res = await fetch(`${app.baseUrl}/api/checkouts/${checkoutId}/export`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    expect(res.status).toBe(200);
    expectOnlyData(res, 'export');
    const disposition = res.headers.get('content-disposition')!;
    expect(disposition).toMatch(/^attachment; filename="[\w.-]+"$/);
    expect(JSON.parse(await res.text()).routingKey).toBe(IN_ROUTING_KEY);
  });

  it('shows the queue name as text in the queue list', async () => {
    const { queues } = await (await read('/api/profiles/local/vhosts/%2F/queues')).json();
    const html = renderToStaticMarkup(
      createElement(QueueTable, {
        queues: queues.filter((q: { name: string }) => q.name === IN_QUEUE_NAME),
        profile: 'local',
        vhost: '/',
        role: 'admin',
        focused: undefined,
        onFocus() {},
        onCheckout() {},
      }),
    );
    expect(html).toContain(asText(IN_QUEUE_NAME));
    expect(html).not.toMatch(FORBIDDEN_TAGS);
  });

  it('shows the routing key and message id as text in the list of held Messages', async () => {
    const { checkout } = await (await read(`/api/checkouts/${checkoutId}`)).json();
    const html = renderToStaticMarkup(
      createElement(MessageList, {
        messages: checkout.messages,
        empty: 'none',
        quorum: false,
        focused: row.handle,
        onFocus() {},
      }),
    );
    expect(html).toContain(asText(IN_ROUTING_KEY));
    expect(html).toContain(asText(IN_MESSAGE_ID));
    expect(html).not.toMatch(FORBIDDEN_TAGS);
  });

  it('shows the body, headers, routing key and message id as text in the Message view', async () => {
    const { message } = await (await read(`/api/checkouts/${checkoutId}/messages/${row.handle}`)).json();
    const html = renderToStaticMarkup(createElement(MessageDetailView, { message }));
    expect(html).toContain(asText(IN_BODY));
    expect(html).toContain(asText(IN_ROUTING_KEY));
    expect(html).toContain(asText(IN_MESSAGE_ID));
    // The headers are shown as JSON, whose own quotes are written as text too.
    expect(html).toContain(asText(JSON.stringify(IN_HEADER)));
    expect(html).not.toMatch(FORBIDDEN_TAGS);
  });

  it('has nowhere else to go: the web app has no way to write a string as markup', async () => {
    const webSource = path.join(import.meta.dirname, '../../src/web');
    const sinks = /dangerouslySetInnerHTML|innerHTML|outerHTML|insertAdjacentHTML|document\.write|srcDoc|createContextualFragment|DOMParser|\beval\(|new Function/;
    const found: string[] = [];
    for (const file of await readdir(webSource)) {
      if (!/\.tsx?$/.test(file)) continue;
      if (sinks.test(await readFile(path.join(webSource, file), 'utf8'))) found.push(file);
    }
    expect(found).toEqual([]);
  });
});
