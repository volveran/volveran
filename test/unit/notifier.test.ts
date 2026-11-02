// Delivery of notifications: timeout, attempts with back-off, the recorded
// outcome, and deliveries that do not wait for each other. Against a real
// local HTTP Alert Destination, with short timings; the integration tests cover the
// real timings through the test endpoint.
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { CLOSE_WAIT_MS, Notifier, type NotifierOptions } from '../../src/server/alerts/notifier.js';
import { testNotification } from '../../src/server/alerts/payloads.js';
import { SqliteAuditStore } from '../../src/server/audit/sqlite-audit-store.js';

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

  function notifierFor(destinations: Record<string, string>, deliveryTiming = timing, closing: Pick<NotifierOptions, 'closeWaitMs' | 'onCloseWaitRanOut'> = { closeWaitMs: 20 }) {
    const store = new SqliteAuditStore();
    cleanups.push(() => store.close());
    const notifier = new Notifier({
      destinations: Object.entries(destinations).map(([name, url]) => ({ name, type: 'webhook', url, signingSecret: null })),
      store: store.notifications,
      publicUrl: null,
      timing: deliveryTiming,
      ...closing,
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
    expect((await store.notifications.recent()).map((d) => [d.destination, d.outcome, d.httpStatus])).toEqual([
      ['bad', 'failed', 404],
      ['ok', 'delivered', 200],
    ]);
  });

  it('keeps the Replay Rule of a notification, and none when it has no Replay Rule', async () => {
    const url = await destination((_req, res) => res.writeHead(204).end());
    const { notifier, store } = notifierFor({ pager: url });
    await notifier.send('pager', { ...testNotification(new Date(), 'a'), replayRule: 'retry' });
    await notifier.send('pager', testNotification(new Date(), 'b'));
    expect((await store.notifications.recent()).map((d) => [d.alertId, d.replayRule])).toEqual([['b', null], ['a', 'retry']]);
  });

  it('waits 5 s on close by default', () => {
    expect(CLOSE_WAIT_MS).toBe(5_000);
  });

  it('on close, lets a delivery in progress finish within the limit', async () => {
    const slow = await destination((_req, res) => void setTimeout(() => res.end(), 100));
    const ranOut: number[] = [];
    const { notifier } = notifierFor({ slow }, timing, { closeWaitMs: 10_000, onCloseWaitRanOut: (n) => ranOut.push(n) });
    const delivery = notifier.send('slow', notification());
    await notifier.close();
    expect(await delivery).toMatchObject({ outcome: 'delivered' });
    expect(ranOut).toEqual([]);
  });

  it('on close, is not held past the limit by a destination that never answers: it ends the delivery, records it and says so', async () => {
    const hung = await destination(() => {});
    const ranOut: number[] = [];
    // Attempts far longer than the limit, so only the limit can end this.
    const { notifier, store } = notifierFor({ hung }, { timeoutMs: 60_000, firstBackoffMs: 1 }, { closeWaitMs: 100, onCloseWaitRanOut: (n) => ranOut.push(n) });
    const delivery = notifier.send('hung', notification());
    const started = Date.now();
    await notifier.close();
    const took = Date.now() - started;
    expect(took).toBeGreaterThanOrEqual(90);
    expect(took).toBeLessThan(5_000);
    expect(ranOut).toEqual([1]);
    expect(await delivery).toMatchObject({ outcome: 'failed', error: 'server_stopping' });
    expect(await store.notifications.recent()).toHaveLength(1);
  });

  it('refuses a destination the file does not declare', async () => {
    const { notifier } = notifierFor({});
    await expect(notifier.send('nope', notification())).rejects.toMatchObject({ status: 404, code: 'alert_destination_not_found' });
  });
});
