// Delivery of notifications: timeout, attempts with back-off, the recorded
// outcome, and deliveries that do not wait for each other. Against a real
// local HTTP Alert Destination, with short timings; the integration tests cover the
// real timings through the test endpoint.
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { Notifier } from '../../src/server/alerts/notifier.js';
import { testNotification } from '../../src/server/alerts/payloads.js';
import { AuditStore } from '../../src/server/audit/store.js';

// A timeout long enough for a loaded machine's local request; the timeout test sets a short one.
const timing = { timeoutMs: 5_000, firstBackoffMs: 5 };

describe('Notifier', () => {
  const cleanups: Array<() => unknown> = [];
  afterEach(async () => {
    for (const clean of cleanups.splice(0).reverse()) await clean();
  });

  async function destination(handle: http.RequestListener) {
    const server = http.createServer(handle);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    cleanups.push(() => {
      server.closeAllConnections();
      return new Promise((resolve) => server.close(resolve));
    });
    return `http://127.0.0.1:${(server.address() as AddressInfo).port}/hook`;
  }

  function notifierFor(destinations: Record<string, string>, deliveryTiming = timing) {
    const store = new AuditStore();
    cleanups.push(() => store.close());
    const notifier = new Notifier({
      destinations: Object.entries(destinations).map(([name, url]) => ({ name, type: 'webhook', url, signingSecret: null })),
      store: store.async.notifications,
      publicUrl: null,
      timing: deliveryTiming,
    });
    cleanups.push(() => notifier.close());
    return { notifier, store };
  }

  const notification = () => testNotification(new Date(), 'id');

  it('gives up on a destination that does not answer in time, and records a timeout after three attempts', async () => {
    const url = await destination(() => {});
    const { notifier } = notifierFor({ slow: url }, { timeoutMs: 100, firstBackoffMs: 5 });
    const delivery = await notifier.send('slow', notification());
    expect(delivery).toMatchObject({ outcome: 'failed', httpStatus: null, error: 'timeout', attempts: 3 });
  });

  it('records why an unreachable destination failed, without its URL', async () => {
    const closed = http.createServer();
    await new Promise<void>((resolve) => closed.listen(0, '127.0.0.1', resolve));
    const { port } = closed.address() as AddressInfo;
    await new Promise((resolve) => closed.close(resolve));
    const { notifier } = notifierFor({ gone: `http://127.0.0.1:${port}/hook-secret` });
    const delivery = await notifier.send('gone', notification());
    expect(delivery).toMatchObject({ outcome: 'failed', httpStatus: null, attempts: 3 });
    expect(JSON.stringify(delivery)).not.toContain('hook-secret');
    expect(delivery.error).toBe('ECONNREFUSED');
  });

  it('does not follow a redirect, which would hand the body to another address', async () => {
    let followed = false;
    const target = await destination((_req, res) => {
      followed = true;
      res.end();
    });
    const url = await destination((_req, res) => {
      res.writeHead(302, { location: target });
      res.end();
    });
    const { notifier } = notifierFor({ moved: url });
    expect(await notifier.send('moved', notification())).toMatchObject({ outcome: 'failed', httpStatus: 302 });
    expect(followed).toBe(false);
  });

  it('does not make one delivery wait for another', async () => {
    const hung = await destination(() => {});
    const quick = await destination((_req, res) => res.end());
    const { notifier } = notifierFor({ hung, quick });
    let hungEnded = false;
    const slow = notifier.send('hung', notification()).finally(() => (hungEnded = true));
    expect(await notifier.send('quick', notification())).toMatchObject({ outcome: 'delivered', attempts: 1 });
    expect(hungEnded).toBe(false);
    await notifier.close();
    await slow;
  });

  it('keeps the outcome of each delivery, newest first', async () => {
    const ok = await destination((_req, res) => res.end());
    const bad = await destination((_req, res) => {
      res.statusCode = 404;
      res.end();
    });
    const { notifier, store } = notifierFor({ ok, bad });
    await notifier.send('ok', notification());
    await notifier.send('bad', notification());
    expect(store.notifications.recent().map((d) => [d.destination, d.outcome, d.httpStatus])).toEqual([
      ['bad', 'failed', 404],
      ['ok', 'delivered', 200],
    ]);
  });

  it('keeps the Replay Rule of a notification, and none when it has no Replay Rule', async () => {
    const url = await destination((_req, res) => res.writeHead(204).end());
    const { notifier, store } = notifierFor({ pager: url });
    await notifier.send('pager', { ...testNotification(new Date(), 'a'), replayRule: 'retry' });
    await notifier.send('pager', testNotification(new Date(), 'b'));
    expect(store.notifications.recent().map((d) => [d.alertId, d.replayRule])).toEqual([['b', null], ['a', 'retry']]);
  });

  it('on close, ends the deliveries in progress at once and records them', async () => {
    const hung = await destination(() => {});
    const { notifier, store } = notifierFor({ hung });
    const delivery = notifier.send('hung', notification());
    await new Promise((resolve) => setTimeout(resolve, 20));
    await notifier.close();
    expect(await delivery).toMatchObject({ outcome: 'failed', error: 'server_stopping' });
    expect(store.notifications.recent()).toHaveLength(1);
  });

  it('refuses a destination the file does not declare', async () => {
    const { notifier } = notifierFor({});
    await expect(notifier.send('nope', notification())).rejects.toMatchObject({ status: 404, code: 'alert_destination_not_found' });
  });
});

describe('notifications table', () => {
  it('removes outcomes older than the retention, and keeps the rest', async () => {
    const store = new AuditStore();
    const entry = (at: string) => ({
      at: new Date(at),
      alertId: 'a',
      destination: 'd',
      destinationType: 'slack' as const,
      status: 'firing' as const,
      test: false,
      rule: 'r',
      profile: 'p',
      vhost: '/',
      queue: 'q', replayRule: null,
      outcome: 'delivered' as const,
      httpStatus: 200,
      error: null,
      attempts: 1,
    });
    store.notifications.record(entry('2026-01-01T00:00:00Z'));
    store.notifications.record(entry('2026-03-01T00:00:00Z'));
    expect(store.notifications.removeOlderThan(new Date('2026-02-01T00:00:00Z'))).toBe(1);
    expect(store.notifications.recent().map((d) => d.at)).toEqual(['2026-03-01T00:00:00.000Z']);
    store.close();
  });
});
