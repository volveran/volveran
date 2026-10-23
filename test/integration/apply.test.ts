// Apply with Discard through the HTTP API, against the real broker (ADR 0001):
// a Discarded Message is stored durably, then acked; every other Message goes
// back to the queue in order; a Checkout that stops being active mid-Apply
// stops the Apply there.
import { spawn, type ChildProcess } from 'node:child_process';
import { rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { stringify } from 'yaml';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { repoRoot } from '../../scripts/test-broker-env.mjs';
import {
  brokerUsers,
  checkoutConnectionNames,
  closeConnection,
  deadLetter,
  deadLetterRoutes,
  eventually,
  fixtureQueues,
  makeTempDir,
  purgeQueues,
  readyMessageIds,
  seedMessages,
  sleep,
  startApp,
  testOperator,
  testProfile,
  type TestApp,
} from './harness.js';

const checkoutPath = (queue: string) => `/api/profiles/local/vhosts/%2F/queues/${encodeURIComponent(queue)}/checkouts`;
const discard = (reason = 'duplicate order') => ({ kind: 'discard', reason });
const KEEP = { kind: 'keep' };

type Hook = ((entryId: number) => Promise<void>) | null;

describe('Apply with Discard', () => {
  let app: TestApp;
  let beforeApplyStep: Hook = null;
  const open: string[] = [];

  async function startCheckout(queue: string, on: TestApp = app) {
    const res = await on.post(checkoutPath(queue));
    expect(res.status).toBe(201);
    const checkout = res.body.checkout;
    open.push(checkout.id);
    /** Message handle by message_id. */
    const handle = (messageId: string): number => checkout.messages.find((m: any) => m.messageId === messageId).handle;
    return { checkout, id: checkout.id as string, handle };
  }

  const decide = (id: string, handles: number[], decision: unknown, on: TestApp = app) =>
    on.post(`/api/checkouts/${id}/decisions`, { handles, decision });
  const apply = (id: string, on: TestApp = app) => on.post(`/api/checkouts/${id}/apply`, { confirm: true });

  beforeAll(async () => {
    app = await startApp({
      profiles: [testProfile({ name: 'local' })],
      checkoutTestHooks: { beforeApplyStep: async (entryId) => beforeApplyStep?.(entryId) },
    });
  });
  afterEach(async () => {
    beforeApplyStep = null;
    while (open.length) await app.delete(`/api/checkouts/${open.pop()}`);
    await purgeQueues('/', fixtureQueues);
  });
  afterAll(async () => {
    await app?.close();
  });

  it.each(['orders.dlq', 'payments.dlq'])(
    'on %s removes only the Discarded Messages and returns the others in order',
    async (queue) => {
      await seedMessages('/', queue, 5);
      const { id, handle } = await startCheckout(queue);
      await decide(id, [handle(`${queue}-1`), handle(`${queue}-3`)], discard());

      const unconfirmed = await app.post(`/api/checkouts/${id}/apply`, {});
      expect([unconfirmed.status, unconfirmed.body.error.code]).toEqual([400, 'confirmation_required']);

      const applied = await apply(id);

      expect(applied.status).toBe(200);
      expect(applied.body.outcomes).toEqual(
        [0, 1, 2, 3, 4].map((n) => ({
          handle: handle(`${queue}-${n}`),
          messageId: `${queue}-${n}`,
          decision: n % 2 ? discard() : KEEP,
          status: n % 2 ? 'done' : 'kept',
          reason: null,
        })),
      );
      expect(applied.body.checkout).toMatchObject({ status: 'ended', endReason: 'applied', heldCount: 0 });
      expect(applied.body.checkout.lastApply.outcomes).toEqual(applied.body.outcomes);
      expect(await readyMessageIds('/', queue)).toEqual([0, 2, 4].map((n) => `${queue}-${n}`));
      // The queue and the Operator are free for the next Checkout.
      await startCheckout(queue);
    },
  );

  it('stores a byte-identical copy of each Discarded Message with the reason, the Operator and the broker user', async () => {
    const body = Buffer.from([0x7b, 0x00, 0xff, 0x80, 0x0a, 0x7d]);
    await deadLetter(deadLetterRoutes.quorum, [
      {
        body,
        options: {
          messageId: 'pay-1',
          contentType: 'application/octet-stream',
          correlationId: 'corr-1',
          timestamp: 1792139557,
          headers: { tenant: 'acme', raw: Buffer.from([0, 255]) },
        },
      },
      { body: 'keep me', options: { messageId: 'pay-2' } },
    ]);
    const { id, handle } = await startCheckout('payments.dlq');
    await decide(id, [handle('pay-1')], discard('  card declined twice  '));
    const before = Date.now();

    expect((await apply(id)).status).toBe(200);

    const listed = await app.get(`/api/audit-entries?checkoutId=${id}`);
    expect(listed.status).toBe(200);
    expect(listed.body.entries).toHaveLength(1);
    const [summary] = listed.body.entries;
    expect(summary).toMatchObject({
      operatorId: testOperator,
      operatorName: testOperator,
      brokerUser: brokerUsers.admin.username,
      profile: 'local',
      vhost: '/',
      queue: 'payments.dlq',
      messageId: 'pay-1',
      action: 'discard',
      reason: 'card declined twice',
      destination: null,
      outcome: 'done',
      outcomeReason: null,
      checkoutId: id,
    });
    expect(Date.parse(summary.at)).toBeGreaterThanOrEqual(before - 1000);
    expect(summary.message.body).toBeUndefined(); // listing never carries bodies

    const { entry } = (await app.get(`/api/audit-entries/${summary.id}`)).body;
    expect(Buffer.from(entry.message.body, 'base64').equals(body)).toBe(true);
    expect(entry.message.bodyBytes).toBe(body.length);
    expect(entry.message.properties).toMatchObject({
      messageId: 'pay-1',
      contentType: 'application/octet-stream',
      correlationId: 'corr-1',
      timestamp: 1792139557,
    });
    expect(entry.message.headers).toMatchObject({
      tenant: 'acme',
      raw: { $bytes: Buffer.from([0, 255]).toString('base64') },
      'x-death': [expect.objectContaining({ queue: 'payments.work', reason: 'rejected', exchange: 'payments' })],
    });
    expect(await readyMessageIds('/', 'payments.dlq')).toEqual(['pay-2']);
  });

  it('refuses Apply on a Checkout that has ended', async () => {
    await seedMessages('/', 'orders.dlq', 1);
    const { id, handle } = await startCheckout('orders.dlq');
    await decide(id, [handle('orders.dlq-0')], discard());
    await app.delete(`/api/checkouts/${id}`);

    const applied = await apply(id);

    expect([applied.status, applied.body.error.code]).toEqual([409, 'checkout_not_active']);
    expect(await readyMessageIds('/', 'orders.dlq')).toEqual(['orders.dlq-0']);
  });

  it('refuses Apply on a Lost Checkout, saying why it was lost', async () => {
    await seedMessages('/', 'orders.dlq', 2);
    const { id, handle } = await startCheckout('orders.dlq');
    await decide(id, [handle('orders.dlq-0')], discard());
    const names = await eventually(async () => {
      const found = await checkoutConnectionNames('orders.dlq');
      expect(found).toHaveLength(1);
      return found;
    });
    await closeConnection(names[0]!);
    await eventually(async () => expect((await app.get(`/api/checkouts/${id}`)).body.checkout.status).toBe('lost'));

    const applied = await apply(id);

    expect([applied.status, applied.body.error.code]).toEqual([409, 'checkout_not_active']);
    expect(applied.body.error.message).toMatch(/lost.*connection to the broker was closed/);
    expect(await readyMessageIds('/', 'orders.dlq')).toEqual(['orders.dlq-0', 'orders.dlq-1']);
    expect((await app.get(`/api/audit-entries?checkoutId=${id}`)).body.entries).toEqual([]);
  });

  it('keeps the finished Discards and returns every other Message when the connection drops mid-Apply', async () => {
    await seedMessages('/', 'orders.dlq', 8);
    const { checkout, id } = await startCheckout('orders.dlq');
    const all: number[] = checkout.messages.map((m: any) => m.handle);
    await decide(id, all.slice(0, 6), discard());
    const [connection] = await eventually(async () => {
      const found = await checkoutConnectionNames('orders.dlq');
      expect(found).toHaveLength(1);
      return found;
    });
    let steps = 0;
    // Drop the connection once the third Discard is stored, before its ack.
    beforeApplyStep = async () => {
      if (++steps !== 3) return;
      await closeConnection(connection!);
      await eventually(async () => expect((await app.get(`/api/checkouts/${id}`)).body.checkout.status).toBe('lost'));
    };

    const applied = await apply(id);

    expect(applied.status).toBe(200);
    expect(applied.body.checkout.status).toBe('lost');
    expect(applied.body.outcomes.map((o: any) => [o.messageId, o.status])).toEqual([
      ['orders.dlq-0', 'done'],
      ['orders.dlq-1', 'done'],
      ['orders.dlq-2', 'failed'],
      ['orders.dlq-3', 'not-attempted'],
      ['orders.dlq-4', 'not-attempted'],
      ['orders.dlq-5', 'not-attempted'],
      ['orders.dlq-6', 'kept'],
      ['orders.dlq-7', 'kept'],
    ]);
    expect(await readyMessageIds('/', 'orders.dlq')).toEqual([2, 3, 4, 5, 6, 7].map((n) => `orders.dlq-${n}`));
    const { entries } = (await app.get(`/api/audit-entries?checkoutId=${id}`)).body;
    expect(entries.map((e: any) => [e.messageId, e.outcome]).reverse()).toEqual([
      ['orders.dlq-0', 'done'],
      ['orders.dlq-1', 'done'],
      ['orders.dlq-2', 'failed'],
    ]);
  });

  it('does not let the time limit or a missing heartbeat end the Checkout while Apply runs', async () => {
    const quick = await startApp({
      profiles: [testProfile({ name: 'local' })],
      checkoutTiming: { timeLimitMs: 1_000, heartbeatWindowMs: 1_000 },
      checkoutTestHooks: { beforeApplyStep: async (entryId) => beforeApplyStep?.(entryId) },
    });
    try {
      await seedMessages('/', 'orders.dlq', 3);
      const { checkout, id } = await startCheckout('orders.dlq', quick);
      await decide(id, checkout.messages.map((m: any) => m.handle).slice(0, 2), discard(), quick);
      beforeApplyStep = () => sleep(1_500); // both timers fire during the first step

      const applied = await apply(id, quick);

      expect(applied.body.outcomes.map((o: any) => o.status)).toEqual(['done', 'done', 'kept']);
      expect(applied.body.checkout).toMatchObject({ status: 'ended', endReason: 'applied' });
      expect(await readyMessageIds('/', 'orders.dlq')).toEqual(['orders.dlq-2']);
    } finally {
      open.length = 0;
      await quick.close();
    }
  });

  describe('when the process is killed between storing a Discarded Message and acking it', () => {
    let dir: string;
    let child: ChildProcess | undefined;
    afterEach(async () => {
      child?.kill('SIGKILL');
      if (dir) await rm(dir, { recursive: true, force: true });
    });

    /** Runs test/integration/die-before-ack-server.ts; resolves with its URL. */
    async function spawnServer(dataDir: string): Promise<string> {
      const profilesFile = path.join(dir, 'profiles.yaml');
      await writeFile(profilesFile, stringify({ profiles: [testProfile({ name: 'local', passwordEnv: 'LOCAL_PW' })] }));
      child = spawn(process.execPath, ['--import', 'tsx', 'test/integration/die-before-ack-server.ts'], {
        cwd: repoRoot,
        env: {
          PATH: process.env.PATH,
          VOLVERAN_PROFILES_FILE: profilesFile,
          VOLVERAN_DATA_DIR: dataDir,
          VOLVERAN_OPERATOR: 'killed-operator',
          LOCAL_PW: brokerUsers.admin.password,
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      return new Promise((resolve, reject) => {
        let out = '';
        child!.stdout!.on('data', (chunk: Buffer) => {
          out += chunk.toString();
          const url = /listening on (http:\/\/\S+)/.exec(out)?.[1];
          if (url) resolve(url);
        });
        child!.stderr!.on('data', (chunk: Buffer) => (out += chunk.toString()));
        child!.on('exit', (code) => reject(new Error(`server exited with ${code}: ${out}`)));
      });
    }

    it('leaves the Message in the queue and in the store, never lost', async () => {
      dir = await makeTempDir('killed-apply');
      const dataDir = path.join(dir, 'data');
      await seedMessages('/', 'orders.dlq', 2);
      const url = await spawnServer(dataDir);
      const post = (urlPath: string, body: unknown) =>
        fetch(url + urlPath, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
      const { checkout } = await (await post(checkoutPath('orders.dlq'), {})).json();
      await post(`/api/checkouts/${checkout.id}/decisions`, { handles: [checkout.messages[0].handle], decision: discard() });
      const exited = new Promise((resolve) => child!.once('exit', resolve));

      await post(`/api/checkouts/${checkout.id}/apply`, { confirm: true }).catch(() => null);
      await exited;

      await eventually(async () =>
        expect((await readyMessageIds('/', 'orders.dlq')).sort()).toEqual(['orders.dlq-0', 'orders.dlq-1']),
      );
      const restarted = await startApp({ profiles: [testProfile({ name: 'local' })], dataDir });
      try {
        const { entries } = (await restarted.get('/api/audit-entries')).body;
        expect(entries.map((e: any) => [e.messageId, e.action, e.outcome, e.operatorName])).toEqual([
          ['orders.dlq-0', 'discard', 'pending', 'killed-operator'],
        ]);
        const { entry } = (await restarted.get(`/api/audit-entries/${entries[0].id}`)).body;
        expect(Buffer.from(entry.message.body, 'base64').toString()).toBe('{"n":0}');
      } finally {
        await restarted.close();
      }
    });
  });
});
