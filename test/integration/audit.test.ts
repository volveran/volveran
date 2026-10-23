// Audit browsing, Restore and body retention through the HTTP API, against
// the real broker: a Restore republishes a Discarded Message from its Audit
// Entry (same rules as Replay) and writes its own Audit Entry; retention
// evicts Discarded bodies by age and by size, and an evicted entry cannot be
// Restored.
import { rm } from 'node:fs/promises';
import type * as amqp from 'amqplib';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { AuditStore, type NewAuditEntry } from '../../src/server/audit/store.js';
import {
  deadLetter,
  deadLetterRoutes,
  drain,
  eventually,
  fixtureQueues,
  makeTempDir,
  purgeQueues,
  readyMessageIds,
  startApp,
  testOperator,
  testProfile,
  uniqueName,
  withChannel,
  type TestApp,
} from './harness.js';

const checkoutPath = (queue: string) => `/api/profiles/local/vhosts/%2F/queues/${encodeURIComponent(queue)}/checkouts`;
const DAY = 24 * 60 * 60 * 1000;

/** Takes every ready Message in `queue`, auto-acked. */
const take = (queue: string) => withChannel('/', (ch) => drain(ch, queue));

/** Puts Messages straight onto `queue` (no dead-lettering). */
async function seed(queue: string, messages: Array<{ body: string | Buffer; options: amqp.Options.Publish }>) {
  await withChannel('/', async (ch) => {
    for (const m of messages) ch.sendToQueue(queue, Buffer.from(m.body), m.options);
    await ch.waitForConfirms();
  });
}

/** Discards the Messages with these message ids from `queue` with a Checkout and Apply; returns their Audit Entries. */
async function discard(app: TestApp, queue: string, messageIds: string[], confirmQueueName?: string) {
  const started = await app.post(checkoutPath(queue));
  expect(started.status).toBe(201);
  const { checkout } = started.body;
  const handles = checkout.messages.filter((m: any) => messageIds.includes(m.messageId)).map((m: any) => m.handle);
  expect(handles).toHaveLength(messageIds.length);
  await app.post(`/api/checkouts/${checkout.id}/decisions`, { handles, decision: { kind: 'discard', reason: 'bad payload' } });
  const applied = await app.post(`/api/checkouts/${checkout.id}/apply`, { confirm: true, confirmQueueName });
  expect(applied.status).toBe(200);
  const { entries } = (await app.get(`/api/audit-entries?checkoutId=${checkout.id}`)).body;
  return entries as any[];
}

describe('Audit browsing and Restore', () => {
  let app: TestApp;
  const tempQueues: string[] = [];

  beforeAll(async () => {
    app = await startApp({ profiles: [testProfile({ name: 'local' })] });
  });
  afterEach(async () => {
    while (tempQueues.length) {
      const q = tempQueues.pop()!;
      await withChannel('/', (ch) => ch.deleteQueue(q));
    }
    await purgeQueues('/', fixtureQueues);
  });
  afterAll(async () => {
    await app?.close();
  });

  it('Restores a Discarded Message to its source queue byte for byte, with x-volveran-* headers and its own Audit Entry', async () => {
    const body = Buffer.from([0x7b, 0x00, 0xff, 0xfe, 0x7d]);
    await deadLetter(deadLetterRoutes.classic, [
      {
        body,
        options: {
          messageId: 'order-7',
          contentType: 'application/octet-stream',
          contentEncoding: 'identity',
          correlationId: 'corr-7',
          replyTo: 'orders.replies',
          type: 'order.created',
          appId: 'shop',
          priority: 3,
          timestamp: 1792139557,
          headers: { tenant: 'acme', raw: Buffer.from([0, 255]), attempt: 2, CC: ['triage.manual'] },
        },
      },
    ]);
    // What the Operator Discards: the Message as it sits in the DLQ.
    const [original] = await take('orders.dlq');
    await seed('orders.dlq', [{ body: original!.content, options: original!.properties as amqp.Options.Publish }]);
    await purgeQueues('/', ['triage.manual']);
    const [discarded] = await discard(app, 'orders.dlq', ['order-7']);
    expect(await readyMessageIds('/', 'orders.dlq')).toEqual([]);

    const unconfirmed = await app.post(`/api/audit-entries/${discarded.id}/restore`, {});
    expect([unconfirmed.status, unconfirmed.body.error.code]).toEqual([400, 'confirmation_required']);

    const restored = await app.post(`/api/audit-entries/${discarded.id}/restore`, { confirm: true });

    expect(restored.status).toBe(200);
    expect(restored.body.entry).toMatchObject({
      action: 'restore',
      restoreOf: discarded.id,
      operatorName: testOperator,
      brokerUser: 'volveran-admin',
      profile: 'local',
      vhost: '/',
      queue: 'orders.dlq',
      messageId: 'order-7',
      destination: { exchange: '', routingKey: 'orders.dlq', queue: 'orders.dlq' },
      outcome: 'done',
      outcomeReason: null,
    });
    const [back, ...more] = await take('orders.dlq');
    expect(more).toEqual([]);
    expect(back!.content.equals(body)).toBe(true);
    const { headers, ...properties } = back!.properties;
    const { headers: originalHeaders, ...originalProperties } = original!.properties;
    expect(properties).toEqual(originalProperties);
    const { 'x-death': _death, 'x-first-death-exchange': _a, 'x-first-death-queue': _b, 'x-first-death-reason': _c,
      'x-last-death-exchange': _d, 'x-last-death-queue': _e, 'x-last-death-reason': _f, CC: _cc, ...kept } = originalHeaders!;
    expect(headers).toEqual({
      ...kept,
      'x-volveran-from': 'orders.dlq',
      'x-volveran-replay-id': expect.stringMatching(/^[0-9a-f-]{36}$/),
    });
    // The Restore's Audit Entry records the replay id it published with, so a Message that dies again traces back.
    expect(restored.body.entry.replayId).toBe(headers!['x-volveran-replay-id']);
    const traced = (await app.get(`/api/audit-entries?replayId=${restored.body.entry.replayId}`)).body.entries;
    expect(traced.map((e: any) => e.id)).toEqual([restored.body.entry.id]);
    // CC is not re-applied: nothing reached triage.manual.
    expect(await readyMessageIds('/', 'triage.manual')).toEqual([]);

    const { entries } = (await app.get('/api/audit-entries?messageId=order-7')).body;
    expect(entries.map((e: any) => [e.action, e.outcome])).toEqual([
      ['restore', 'done'],
      ['discard', 'done'],
    ]);
  });

  it('Restores to another existing queue', async () => {
    await seed('orders.dlq', [{ body: 'elsewhere', options: { messageId: 'other-1', headers: { tenant: 'acme' } } }]);
    const [discarded] = await discard(app, 'orders.dlq', ['other-1']);

    const restored = await app.post(`/api/audit-entries/${discarded.id}/restore`, { confirm: true, queue: 'triage.manual' });

    expect(restored.status).toBe(200);
    expect(restored.body.entry).toMatchObject({
      action: 'restore',
      queue: 'orders.dlq',
      destination: { exchange: '', routingKey: 'triage.manual', queue: 'triage.manual' },
      outcome: 'done',
    });
    const [back, ...more] = await take('triage.manual');
    expect(more).toEqual([]);
    expect(back!.content.toString()).toBe('elsewhere');
    expect(back!.properties.headers).toMatchObject({ tenant: 'acme', 'x-volveran-from': 'orders.dlq' });
    expect(await readyMessageIds('/', 'orders.dlq')).toEqual([]);
  });

  it('refuses to Restore to a queue that does not exist, an unknown entry, an entry that is not a Discard, or twice', async () => {
    await seed('orders.dlq', [{ body: 'x', options: { messageId: 'twice-1' } }]);
    const [discarded] = await discard(app, 'orders.dlq', ['twice-1']);

    const missing = await app.post(`/api/audit-entries/${discarded.id}/restore`, { confirm: true, queue: 'no.such.queue' });
    expect([missing.status, missing.body.error.code]).toEqual([422, 'queue_not_found']);

    const notFound = await app.post('/api/audit-entries/999999/restore', { confirm: true });
    expect([notFound.status, notFound.body.error.code]).toEqual([404, 'audit_entry_not_found']);

    expect((await app.post(`/api/audit-entries/${discarded.id}/restore`, { confirm: true })).status).toBe(200);
    const again = await app.post(`/api/audit-entries/${discarded.id}/restore`, { confirm: true });
    expect([again.status, again.body.error.code]).toEqual([409, 'already_restored']);
    expect(await readyMessageIds('/', 'orders.dlq')).toEqual(['twice-1']);

    const restores = (await app.get('/api/audit-entries?action=restore&messageId=twice-1')).body.entries;
    expect(restores).toHaveLength(1);
    const notRestorable = await app.post(`/api/audit-entries/${restores[0].id}/restore`, { confirm: true });
    expect([notRestorable.status, notRestorable.body.error.code]).toEqual([422, 'not_restorable']);
  });

  it('Restores a Message once when two Restores of it are requested at the same moment', async () => {
    await seed('orders.dlq', [{ body: 'x', options: { messageId: 'concurrent-1' } }]);
    const [discarded] = await discard(app, 'orders.dlq', ['concurrent-1']);

    const results = await Promise.all([
      app.post(`/api/audit-entries/${discarded.id}/restore`, { confirm: true }),
      app.post(`/api/audit-entries/${discarded.id}/restore`, { confirm: true }),
    ]);

    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    expect(await readyMessageIds('/', 'orders.dlq')).toEqual(['concurrent-1']);
  });

  it('reports a Restore the broker refuses as failed, and it can be tried again', async () => {
    await seed('orders.dlq', [{ body: 'full', options: { messageId: 'refused-1' } }]);
    const [discarded] = await discard(app, 'orders.dlq', ['refused-1']);
    const fullQueue = uniqueName('restore.full');
    tempQueues.push(fullQueue);
    await withChannel('/', (ch) =>
      ch.assertQueue(fullQueue, { durable: true, arguments: { 'x-max-length': 0, 'x-overflow': 'reject-publish' } }),
    );

    const refused = await app.post(`/api/audit-entries/${discarded.id}/restore`, { confirm: true, queue: fullQueue });

    expect(refused.status).toBe(200);
    expect(refused.body.entry).toMatchObject({ action: 'restore', restoreOf: discarded.id, outcome: 'failed' });
    expect(refused.body.entry.outcomeReason).toEqual(expect.any(String));

    const retried = await app.post(`/api/audit-entries/${discarded.id}/restore`, { confirm: true });
    expect(retried.body.entry.outcome).toBe('done');
    expect(await readyMessageIds('/', 'orders.dlq')).toEqual(['refused-1']);
  });

  it('searches Audit Entries by Broker Profile, queue, message_id, action, Operator and date', async () => {
    await seed('orders.dlq', [
      { body: 'a', options: { messageId: 'search-a' } },
      { body: 'b', options: { messageId: 'search-b' } },
    ]);
    const discards = await discard(app, 'orders.dlq', ['search-a', 'search-b']);
    const a = discards.find((e: any) => e.messageId === 'search-a');
    await app.post(`/api/audit-entries/${a.id}/restore`, { confirm: true, queue: 'triage.manual' });

    const search = async (qs: string) =>
      (await app.get(`/api/audit-entries?${qs}`)).body.entries.map((e: any) => [e.messageId, e.action]);

    expect(await search('messageId=search-a')).toEqual([
      ['search-a', 'restore'],
      ['search-a', 'discard'],
    ]);
    expect(await search('queue=triage.manual&messageId=search-a')).toEqual([['search-a', 'restore']]);
    expect(await search('queue=orders.dlq&action=discard&messageId=search-b')).toEqual([['search-b', 'discard']]);
    expect(await search(`profile=local&operator=${testOperator}&messageId=search-b`)).toEqual([['search-b', 'discard']]);
    expect(await search('profile=elsewhere&messageId=search-b')).toEqual([]);
    expect(await search('operator=someone-else&messageId=search-b')).toEqual([]);
    const today = new Date().toISOString().slice(0, 10);
    expect(await search(`messageId=search-b&from=${today}&to=${today}`)).toEqual([['search-b', 'discard']]);
    expect(await search('messageId=search-b&to=2000-01-01')).toEqual([]);

    const bad = await app.get('/api/audit-entries?action=delete');
    expect([bad.status, bad.body.error.code]).toEqual([400, 'invalid_request']);
  });

  it('keeps Audit Entries in the data directory across a restart, and Restores from them', async () => {
    const dataDir = await makeTempDir('audit-restart');
    try {
      const first = await startApp({ profiles: [testProfile({ name: 'local' })], dataDir });
      let discarded;
      try {
        await seed('orders.dlq', [{ body: 'survivor', options: { messageId: 'restart-1' } }]);
        [discarded] = await discard(first, 'orders.dlq', ['restart-1']);
      } finally {
        await first.close();
      }

      const second = await startApp({ profiles: [testProfile({ name: 'local' })], dataDir });
      try {
        const { entries } = (await second.get('/api/audit-entries?messageId=restart-1')).body;
        expect(entries.map((e: any) => [e.id, e.action, e.outcome])).toEqual([[discarded.id, 'discard', 'done']]);
        const restored = await second.post(`/api/audit-entries/${discarded.id}/restore`, { confirm: true });
        expect(restored.body.entry.outcome).toBe('done');
        const [back] = await take('orders.dlq');
        expect(back!.content.toString()).toBe('survivor');
      } finally {
        await second.close();
      }
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it.each(['pending', 'uncertain'] as const)(
    'Restores a Discard left %s (e.g. Volverán stopped mid-Apply) only once the Operator accepts it may duplicate',
    async (outcome) => {
      const dataDir = await makeTempDir('audit-uncertain');
      try {
        const store = new AuditStore(dataDir);
        const id = store.record(storedDiscard(`uncertain-${outcome}`, 0, 'crashed'));
        if (outcome === 'uncertain') store.setOutcome(id, 'uncertain', 'The connection dropped before the ack was confirmed.');
        store.close();
        const restarted = await startApp({ profiles: [testProfile({ name: 'local' })], dataDir });
        try {
          const refused = await restarted.post(`/api/audit-entries/${id}/restore`, { confirm: true });
          expect([refused.status, refused.body.error.code]).toEqual([409, 'outcome_uncertain']);
          expect(refused.body.error.message).toContain('orders.dlq');
          expect(refused.body.error.message).toMatch(/duplicate/);
          expect(await readyMessageIds('/', 'orders.dlq')).toEqual([]);

          const restored = await restarted.post(`/api/audit-entries/${id}/restore`, { confirm: true, confirmUncertain: true });
          expect(restored.body.entry).toMatchObject({ action: 'restore', restoreOf: id, outcome: 'done' });
          expect(await readyMessageIds('/', 'orders.dlq')).toEqual([`uncertain-${outcome}`]);
        } finally {
          await restarted.close();
        }
      } finally {
        await rm(dataDir, { recursive: true, force: true });
      }
    },
  );

  it('does not Restore a Discard that failed in a known way (its Message stayed in the queue)', async () => {
    const dataDir = await makeTempDir('audit-failed');
    try {
      const store = new AuditStore(dataDir);
      const id = store.record(storedDiscard('failed-1', 0));
      store.setOutcome(id, 'failed', 'The Checkout is no longer active, so the Message was left in the queue.');
      store.close();
      const restarted = await startApp({ profiles: [testProfile({ name: 'local' })], dataDir });
      try {
        const res = await restarted.post(`/api/audit-entries/${id}/restore`, { confirm: true, confirmUncertain: true });
        expect([res.status, res.body.error.code]).toEqual([422, 'not_restorable']);
      } finally {
        await restarted.close();
      }
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  });
});

describe('Restore on a Protected Profile', () => {
  let app: TestApp;
  beforeAll(async () => {
    app = await startApp({ profiles: [testProfile({ name: 'local', protected: true })] });
  });
  afterEach(async () => {
    await purgeQueues('/', fixtureQueues);
  });
  afterAll(async () => {
    await app?.close();
  });

  it('needs the destination queue name typed exactly, checked by the server', async () => {
    await seed('orders.dlq', [{ body: 'guarded', options: { messageId: 'protected-1' } }]);
    const [discarded] = await discard(app, 'orders.dlq', ['protected-1'], 'orders.dlq');
    const restore = (body: object) => app.post(`/api/audit-entries/${discarded.id}/restore`, body);

    for (const confirmQueueName of [undefined, 'orders.dl', 'ORDERS.DLQ', 'orders.dlq ']) {
      const refused = await restore({ confirm: true, confirmQueueName });
      expect([refused.status, refused.body.error.code]).toEqual([400, 'queue_name_confirmation_required']);
    }
    // The typed name is the queue the Message goes to.
    const wrongQueue = await restore({ confirm: true, queue: 'triage.manual', confirmQueueName: 'orders.dlq' });
    expect([wrongQueue.status, wrongQueue.body.error.code]).toEqual([400, 'queue_name_confirmation_required']);
    expect(await readyMessageIds('/', 'orders.dlq')).toEqual([]);
    expect((await app.get('/api/audit-entries?action=restore&messageId=protected-1')).body.entries).toEqual([]);

    const restored = await restore({ confirm: true, queue: 'triage.manual', confirmQueueName: 'triage.manual' });
    expect(restored.body.entry).toMatchObject({ action: 'restore', outcome: 'done' });
    expect(await readyMessageIds('/', 'triage.manual')).toEqual(['protected-1']);
  });
});

describe('Retention of Discarded Message bodies', () => {
  const dirs: string[] = [];
  afterEach(async () => {
    await purgeQueues('/', fixtureQueues);
    while (dirs.length) await rm(dirs.pop()!, { recursive: true, force: true });
  });
  const dataDir = async () => {
    const dir = await makeTempDir('audit-retention');
    dirs.push(dir);
    return dir;
  };

  it('evicts bodies past the age limit on a schedule, keeps the Audit Entries, and refuses to Restore them with the reason', async () => {
    const dir = await dataDir();
    const store = new AuditStore(dir);
    const kept = store.record(storedDiscard('young', 29 * DAY));
    store.close();
    const app = await startApp({
      profiles: [testProfile({ name: 'local' })],
      dataDir: dir,
      env: { VOLVERAN_BODY_RETENTION_DAYS: '30' },
      bodyRetention: { intervalMs: 200 },
    });
    try {
      // Written while the app runs, so only the schedule (not startup) can evict it.
      const late = new AuditStore(dir);
      const expired = late.record(storedDiscard('old', 31 * DAY));
      late.close();

      const entry = await eventually(async () => {
        const res = await app.get(`/api/audit-entries/${expired}`);
        expect(res.body.entry.bodyExpiredAt).toEqual(expect.any(String));
        return res.body.entry;
      }, 5_000);
      expect(entry).toMatchObject({ action: 'discard', messageId: 'old', message: { bodyBytes: 3, body: null } });
      expect((await app.get(`/api/audit-entries/${kept}`)).body.entry).toMatchObject({
        bodyExpiredAt: null,
        message: { body: Buffer.from('young').toString('base64') },
      });

      const refused = await app.post(`/api/audit-entries/${expired}/restore`, { confirm: true });
      expect([refused.status, refused.body.error.code]).toEqual([410, 'body_expired']);
      expect(refused.body.error.message).toMatch(/expired/);
      expect(await readyMessageIds('/', 'orders.dlq')).toEqual([]);
      expect((await app.get('/api/audit-entries?action=restore')).body.entries).toEqual([]);
    } finally {
      await app.close();
    }
  });

  it('evicts the oldest bodies at startup once they exceed the size limit, and reports the store size for the UI warning', async () => {
    const dir = await dataDir();
    const store = new AuditStore(dir);
    const oldest = store.record(storedDiscard('size-1', 3 * DAY, 'c', Buffer.alloc(400, 1)));
    const middle = store.record(storedDiscard('size-2', 2 * DAY, 'c', Buffer.alloc(400, 2)));
    const newest = store.record(storedDiscard('size-3', 1 * DAY, 'c', Buffer.alloc(400, 3)));
    for (const id of [oldest, middle, newest]) store.setOutcome(id, 'done');
    store.close();
    const app = await startApp({
      profiles: [testProfile({ name: 'local' })],
      dataDir: dir,
      env: { VOLVERAN_BODY_RETENTION_MAX_BYTES: '1000' },
    });
    try {
      const expired = async (id: number) => (await app.get(`/api/audit-entries/${id}`)).body.entry.bodyExpiredAt !== null;
      expect([await expired(oldest), await expired(middle), await expired(newest)]).toEqual([true, false, false]);
      expect((await app.get('/api/audit-store')).body).toEqual({
        storedBodyBytes: 800,
        maxBodyBytes: 1000,
        maxAgeDays: 30,
        nearLimit: false,
      });

      const refused = await app.post(`/api/audit-entries/${oldest}/restore`, { confirm: true });
      expect([refused.status, refused.body.error.code]).toEqual([410, 'body_expired']);
      const restored = await app.post(`/api/audit-entries/${newest}/restore`, { confirm: true });
      expect(restored.body.entry.outcome).toBe('done');
      const [back] = await take('orders.dlq');
      expect(back!.content.equals(Buffer.alloc(400, 3))).toBe(true);
    } finally {
      await app.close();
    }

    // Near the limit: the UI warns.
    const near = await startApp({
      profiles: [testProfile({ name: 'local' })],
      dataDir: dir,
      env: { VOLVERAN_BODY_RETENTION_MAX_BYTES: '850' },
    });
    try {
      expect((await near.get('/api/audit-store')).body).toMatchObject({ storedBodyBytes: 800, nearLimit: true });
    } finally {
      await near.close();
    }
  });
});

/** A Discard's Audit Entry as the store holds it, `ageMs` old, with a body of `body`. */
function storedDiscard(messageId: string, ageMs: number, checkoutId = 'c', body: Buffer = Buffer.from(messageId)): NewAuditEntry {
  return {
    at: new Date(Date.now() - ageMs),
    operator: { id: testOperator, displayName: testOperator },
    brokerUser: 'volveran-admin',
    profile: 'local',
    vhost: '/',
    queue: 'orders.dlq',
    messageId,
    action: 'discard',
    reason: 'bad payload',
    destination: null,
    checkoutId,
    message: { body, properties: { messageId }, headers: {} },
  };
}
