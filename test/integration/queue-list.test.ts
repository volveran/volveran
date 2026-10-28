// The queue list of a Broker Profile and vhost: dead-letter queues first
// (by the profile's filter, or because other queues dead-letter into them),
// approximate depth from the management API, and stream queues marked as
// not available for a Checkout.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  attachConsumer,
  eventually,
  fixtureQueues,
  management,
  purgeQueues,
  seedMessages,
  startApp,
  testProfile,
  type TestApp,
} from './harness.js';

/** Every queue of vhost "/" in test/broker/definitions.json. */
const fixtures = [...fixtureQueues, 'events.stream'];
const onlyFixtures = (queues: any[]) => queues.filter((q) => fixtures.includes(q.name));
const names = (queues: any[]) => queues.map((q) => q.name);

describe('queue list', () => {
  let app: TestApp;

  beforeAll(async () => {
    app = await startApp({
      profiles: [testProfile({ name: 'local' }), testProfile({ name: 'filtered', defaultQueueFilter: 'triage.*' })],
    });
  });
  afterAll(async () => {
    await app?.close();
  });

  it('lists every queue in the vhost with its approximate depth, consumer count and type', async () => {
    await purgeQueues('/', ['orders.dlq', 'payments.dlq']);
    await seedMessages('/', 'orders.dlq', 3);
    await seedMessages('/', 'payments.dlq', 2);
    const detach = await attachConsumer('/', 'triage.manual');
    try {
      const queues = await eventually(async () => {
        const res = await app.get('/api/profiles/local/vhosts/%2F/queues');
        expect(res.status).toBe(200);
        const byName = Object.fromEntries(res.body.queues.map((q: any) => [q.name, q]));
        expect(byName['orders.dlq']).toMatchObject({ approximateMessages: 3, type: 'classic', consumers: 0 });
        expect(byName['payments.dlq']).toMatchObject({ approximateMessages: 2, type: 'quorum' });
        expect(byName['triage.manual']).toMatchObject({ consumers: 1 });
        return res.body.queues;
      }, 20_000, 500);

      expect(names(onlyFixtures(queues)).sort()).toEqual([...fixtures].sort());
      expect(queues.find((q: any) => q.name === 'events.stream').type).toBe('stream');
    } finally {
      await detach();
      await purgeQueues('/', ['orders.dlq', 'payments.dlq']);
    }
  });

  it('lists the queues other queues dead-letter into first, each group by name', async () => {
    const res = await app.get('/api/profiles/local/vhosts/%2F/queues');
    expect(names(onlyFixtures(res.body.queues))).toEqual([
      'orders.dlq',
      'orders.dlq.quorum',
      'orders.dlq.quorum-dlx',
      'orders.parked',
      'payments.dlq',
      'payments.dlq.classic',
      'events.stream',
      'orders.work',
      'payments.work',
      'triage.manual',
    ]);
    const byName = Object.fromEntries(res.body.queues.map((q: any) => [q.name, q]));
    expect(byName['orders.dlq']).toMatchObject({
      deadLetterQueue: true,
      deadLetteredFrom: ['orders.work'],
      matchesDefaultFilter: false,
    });
    expect(byName['orders.parked']).toMatchObject({ deadLetterQueue: true, deadLetteredFrom: ['orders.dlq.quorum-dlx'] });
    expect(byName['orders.work']).toMatchObject({ deadLetterQueue: false, deadLetteredFrom: [] });
  });

  it("also counts queues matching the profile's queue-name filter as dead-letter queues", async () => {
    const res = await app.get('/api/profiles/filtered/vhosts/%2F/queues');
    expect(res.body.defaultQueueFilter).toBe('triage.*');
    const queues = onlyFixtures(res.body.queues);
    expect(names(queues).slice(0, 7)).toEqual([
      'orders.dlq',
      'orders.dlq.quorum',
      'orders.dlq.quorum-dlx',
      'orders.parked',
      'payments.dlq',
      'payments.dlq.classic',
      'triage.manual',
    ]);
    expect(queues[6]).toMatchObject({ deadLetterQueue: true, matchesDefaultFilter: true, deadLetteredFrom: [] });
  });

  it('finds dead-letter queues set by a policy, including through the default exchange', async () => {
    const vhost = encodeURIComponent('/');
    const work = 'listtest.policy.work';
    const dlq = 'listtest.policy.dead';
    for (const q of [work, dlq]) {
      expect((await management(`/queues/${vhost}/${q}`, { method: 'PUT', body: { durable: true } })).status).toBeLessThan(300);
    }
    const policy = await management(`/policies/${vhost}/listtest-dlx`, {
      method: 'PUT',
      body: {
        pattern: '^listtest\\.policy\\.work$',
        'apply-to': 'queues',
        definition: { 'dead-letter-exchange': '', 'dead-letter-routing-key': dlq },
      },
    });
    expect(policy.status).toBeLessThan(300);
    try {
      const byName = await eventually(async () => {
        const res = await app.get('/api/profiles/local/vhosts/%2F/queues');
        const rows = Object.fromEntries(res.body.queues.map((q: any) => [q.name, q]));
        expect(rows[dlq]).toMatchObject({ deadLetterQueue: true, deadLetteredFrom: [work] });
        return rows;
      });
      expect(byName[work]).toMatchObject({ deadLetterQueue: false });
    } finally {
      await management(`/policies/${vhost}/listtest-dlx`, { method: 'DELETE' });
      for (const q of [work, dlq]) await management(`/queues/${vhost}/${q}`, { method: 'DELETE' });
    }
  });

  it('marks stream queues as not available for a Checkout, with the reason', async () => {
    const res = await app.get('/api/profiles/local/vhosts/%2F/queues');
    const stream = res.body.queues.find((q: any) => q.name === 'events.stream');
    expect(stream.checkout).toEqual({ available: false, reason: expect.stringMatching(/^Stream queues cannot be checked out/) });
    for (const name of ['orders.dlq', 'payments.dlq']) {
      expect(res.body.queues.find((q: any) => q.name === name).checkout).toEqual({ available: true });
    }
  });

  it('flags a quorum dead-letter queue whose delivery limit drops Messages for lack of a dead-letter exchange', async () => {
    const res = await app.get('/api/profiles/local/vhosts/%2F/queues');
    const byName = Object.fromEntries(res.body.queues.map((q: any) => [q.name, q]));
    expect(byName['orders.dlq.quorum'].setupWarnings).toEqual([
      {
        code: 'messages_dropped_at_delivery_limit',
        severity: 'loses_messages',
        deliveryLimit: 20,
        message: expect.stringMatching(/default delivery-limit \(20\).*dropped.*delivery-limit = -1.*dead-letter exchange/is),
      },
    ]);
    // Only the at-most-once notice of a quorum queue that dead-letters.
    const notice = [expect.objectContaining({ code: 'quorum_at_most_once_dead_lettering' })];
    expect(byName['orders.dlq.quorum-dlx'].setupWarnings).toEqual(notice);
    expect(byName['payments.dlq'].setupWarnings).toEqual([expect.objectContaining({ deliveryLimit: 5 })]);
    expect(byName['payments.work'].setupWarnings).toEqual(notice);
    expect(byName['orders.dlq'].setupWarnings).toEqual([]);
  });

  it('sees a dead-letter exchange or an unlimited delivery limit set by a policy', async () => {
    const vhost = encodeURIComponent('/');
    const queues = ['setupcheck.dlx.dlq', 'setupcheck.unlimited.dlq'];
    for (const q of queues) {
      const put = await management(`/queues/${vhost}/${q}`, { method: 'PUT', body: { durable: true, arguments: { 'x-queue-type': 'quorum' } } });
      expect(put.status).toBeLessThan(300);
    }
    const policies = {
      'setupcheck-dlx': { pattern: '^setupcheck\\.dlx\\.dlq$', definition: { 'dead-letter-exchange': 'orders.dlx' } },
      'setupcheck-unlimited': { pattern: '^setupcheck\\.unlimited\\.dlq$', definition: { 'delivery-limit': -1 } },
    };
    const filtered = await startApp({ profiles: [testProfile({ name: 'setupcheck', defaultQueueFilter: 'setupcheck.*' })] });
    try {
      // A new queue's delivery limit shows up with its first management statistics.
      await eventually(async () => {
        const res = await filtered.get('/api/profiles/setupcheck/vhosts/%2F/queues?search=setupcheck');
        expect(res.body.queues.map((q: any) => q.setupWarnings.map((w: any) => w.deliveryLimit))).toEqual([[20], [20]]);
      }, 20_000, 500);

      for (const [name, { pattern, definition }] of Object.entries(policies)) {
        const put = await management(`/policies/${vhost}/${name}`, { method: 'PUT', body: { pattern, 'apply-to': 'queues', definition } });
        expect(put.status).toBeLessThan(300);
      }
      await eventually(async () => {
        const res = await filtered.get('/api/profiles/setupcheck/vhosts/%2F/queues?search=setupcheck');
        expect(res.body.queues.map((q: any) => [q.name, q.setupWarnings])).toEqual([
          // Only the at-most-once notice of a quorum queue that dead-letters.
          ['setupcheck.dlx.dlq', [expect.objectContaining({ code: 'quorum_at_most_once_dead_lettering' })]],
          ['setupcheck.unlimited.dlq', []],
        ]);
      }, 20_000, 500);
    } finally {
      await filtered.close();
      for (const name of Object.keys(policies)) await management(`/policies/${vhost}/${name}`, { method: 'DELETE' });
      for (const q of queues) await management(`/queues/${vhost}/${q}`, { method: 'DELETE' });
    }
  });

  it('flags a queue whose dead-letter exchange does not exist, set by an argument or by a policy, until it is declared', async () => {
    const vhost = encodeURIComponent('/');
    const byArgument = 'missingdlx.argument.work';
    const byPolicy = 'missingdlx.policy.work';
    const missing = 'missingdlx.nowhere';
    const created = [
      [byArgument, { durable: true, arguments: { 'x-dead-letter-exchange': missing } }],
      [byPolicy, { durable: true }],
    ] as const;
    for (const [q, body] of created) {
      expect((await management(`/queues/${vhost}/${q}`, { method: 'PUT', body })).status).toBeLessThan(300);
    }
    const policy = await management(`/policies/${vhost}/missingdlx`, {
      method: 'PUT',
      body: { pattern: '^missingdlx\\.policy\\.work$', 'apply-to': 'queues', definition: { 'dead-letter-exchange': missing } },
    });
    expect(policy.status).toBeLessThan(300);
    try {
      await eventually(async () => {
        const res = await app.get('/api/profiles/local/vhosts/%2F/queues?search=missingdlx');
        expect(names(res.body.queues)).toEqual([byArgument, byPolicy]);
        for (const q of res.body.queues) {
          expect(q.setupWarnings).toEqual([
            {
              code: 'dead_letter_exchange_missing',
              severity: 'loses_messages',
              deadLetterExchange: missing,
              message: expect.stringMatching(/"missingdlx\.nowhere".*does not exist.*dropped.*Declare/is),
            },
          ]);
        }
      });

      const declare = await management(`/exchanges/${vhost}/${missing}`, { method: 'PUT', body: { type: 'fanout', durable: true } });
      expect(declare.status).toBeLessThan(300);
      const res = await app.get('/api/profiles/local/vhosts/%2F/queues?search=missingdlx');
      expect(res.body.queues.map((q: any) => q.setupWarnings)).toEqual([[], []]);
    } finally {
      await management(`/policies/${vhost}/missingdlx`, { method: 'DELETE' });
      await management(`/exchanges/${vhost}/${missing}`, { method: 'DELETE' });
      for (const [q] of created) await management(`/queues/${vhost}/${q}`, { method: 'DELETE' });
    }
  });

  it('flags a dead-letter queue whose message TTL, queue expiry or drop-head length limit drops Messages, by argument or by policy', async () => {
    const vhost = encodeURIComponent('/');
    const ttl = 'dropping.ttl.dlq';
    const maxLength = 'dropping.maxlength.dlq';
    const expires = 'dropping.expires.dlq';
    const created = [
      [ttl, {}],
      [maxLength, { 'x-max-length': 100 }],
      [expires, { 'x-expires': 3_600_000, 'x-dead-letter-exchange': 'orders.dlx' }],
    ] as const;
    for (const [q, args] of created) {
      expect((await management(`/queues/${vhost}/${q}`, { method: 'PUT', body: { durable: true, arguments: args } })).status).toBeLessThan(300);
    }
    const policy = (name: string, pattern: string, definition: Record<string, unknown>) =>
      management(`/policies/${vhost}/${name}`, { method: 'PUT', body: { pattern, 'apply-to': 'queues', definition } });
    expect((await policy('dropping-ttl', '^dropping\\.ttl\\.dlq$', { 'message-ttl': 60_000 })).status).toBeLessThan(300);
    const filtered = await startApp({ profiles: [testProfile({ name: 'dropping', defaultQueueFilter: 'dropping.*' })] });
    const warnings = async () => {
      const res = await filtered.get('/api/profiles/dropping/vhosts/%2F/queues?search=dropping');
      return Object.fromEntries(res.body.queues.map((q: any) => [q.name, q.setupWarnings]));
    };
    try {
      await eventually(async () => {
        expect(await warnings()).toEqual({
          [ttl]: [
            {
              code: 'dead_letter_queue_drops_messages',
              severity: 'loses_messages',
              settings: ['message-ttl'],
              message: expect.stringMatching(/message TTL of 60000 ms.*dropped.*dead-letter exchange/is),
            },
          ],
          [maxLength]: [expect.objectContaining({ settings: ['max-length'], message: expect.stringContaining('drop-head') })],
          [expires]: [expect.objectContaining({ settings: ['expires'], message: expect.stringContaining('expires after 3600000 ms') })],
        });
      });

      // Dead-lettering onward clears the TTL and the length limit, not the expiry, which deletes the queue's Messages.
      expect((await policy('dropping-ttl', '^dropping\\.ttl\\.dlq$', { 'message-ttl': 60_000, 'dead-letter-exchange': 'orders.dlx' })).status).toBeLessThan(300);
      expect((await policy('dropping-maxlength', '^dropping\\.maxlength\\.dlq$', { 'dead-letter-exchange': 'orders.dlx' })).status).toBeLessThan(300);
      await eventually(async () => {
        expect(await warnings()).toEqual({ [ttl]: [], [maxLength]: [], [expires]: [expect.objectContaining({ settings: ['expires'] })] });
      });
    } finally {
      await filtered.close();
      for (const name of ['dropping-ttl', 'dropping-maxlength']) await management(`/policies/${vhost}/${name}`, { method: 'DELETE' });
      for (const [q] of created) await management(`/queues/${vhost}/${q}`, { method: 'DELETE' });
    }
  });

  it('notes a quorum queue that dead-letters with the default at-most-once strategy, not one set to at-least-once', async () => {
    const vhost = encodeURIComponent('/');
    const atMostOnce = 'strategy.atmostonce.work';
    const atLeastOnce = 'strategy.atleastonce.work';
    const created = [
      [atMostOnce, {}],
      [atLeastOnce, { 'x-dead-letter-strategy': 'at-least-once', 'x-overflow': 'reject-publish' }],
    ] as const;
    for (const [q, args] of created) {
      const body = { durable: true, arguments: { 'x-queue-type': 'quorum', 'x-dead-letter-exchange': 'orders.dlx', ...args } };
      expect((await management(`/queues/${vhost}/${q}`, { method: 'PUT', body })).status).toBeLessThan(300);
    }
    try {
      await eventually(async () => {
        const res = await app.get('/api/profiles/local/vhosts/%2F/queues?search=strategy');
        expect(res.body.queues.map((q: any) => [q.name, q.setupWarnings])).toEqual([
          [atLeastOnce, []],
          [
            atMostOnce,
            [
              {
                code: 'quorum_at_most_once_dead_lettering',
                severity: 'may_lose_messages',
                message: expect.stringMatching(/default at-most-once.*lost.*at-least-once.*reject-publish/is),
              },
            ],
          ],
        ]);
      });
    } finally {
      for (const [q] of created) await management(`/queues/${vhost}/${q}`, { method: 'DELETE' });
    }
  });

  it('shows every warning on a queue, and counts the warnings of the whole vhost by severity', async () => {
    const vhost = encodeURIComponent('/');
    const q = 'bothwarnings.dlq';
    const put = await management(`/queues/${vhost}/${q}`, {
      method: 'PUT',
      body: { durable: true, arguments: { 'x-queue-type': 'quorum', 'x-dead-letter-exchange': 'bothwarnings.nowhere' } },
    });
    expect(put.status).toBeLessThan(300);
    const filtered = await startApp({ profiles: [testProfile({ name: 'bothwarnings', defaultQueueFilter: 'bothwarnings.*' })] });
    try {
      // A new queue's delivery limit shows up with its first management statistics.
      const all = await eventually(async () => {
        const res = await filtered.get('/api/profiles/bothwarnings/vhosts/%2F/queues');
        const row = res.body.queues.find((r: any) => r.name === q);
        expect(row.setupWarnings.map((w: any) => [w.code, w.severity])).toEqual([
          ['messages_dropped_at_delivery_limit', 'loses_messages'],
          ['dead_letter_exchange_missing', 'loses_messages'],
        ]);
        return res.body;
      }, 20_000, 500);

      const tally = { loses_messages: 0, may_lose_messages: 0 };
      for (const row of all.queues) for (const w of row.setupWarnings) tally[w.severity as keyof typeof tally]++;
      // The two fixture delivery limits (orders.dlq.quorum, payments.dlq) and this queue's two; the
      // at-most-once notices of the fixture quorum queues that dead-letter (orders.dlq.quorum-dlx, payments.work).
      expect(tally).toEqual({ loses_messages: 4, may_lose_messages: 2 });
      expect(all.setupWarningCounts).toEqual(tally);

      // The count is the whole vhost's, whatever the search and the dead-letter queue filter leave listed.
      const narrowed = await filtered.get(`/api/profiles/bothwarnings/vhosts/%2F/queues?search=${q}&onlyDeadLetterQueues=true`);
      expect(names(narrowed.body.queues)).toEqual([q]);
      expect(narrowed.body.setupWarningCounts).toEqual(tally);
    } finally {
      await filtered.close();
      await management(`/queues/${vhost}/${q}`, { method: 'DELETE' });
    }
  });

  it('narrows the list to dead-letter queues on request', async () => {
    const res = await app.get('/api/profiles/filtered/vhosts/%2F/queues?onlyDeadLetterQueues=true');
    expect(names(onlyFixtures(res.body.queues))).toEqual([
      'orders.dlq',
      'orders.dlq.quorum',
      'orders.dlq.quorum-dlx',
      'orders.parked',
      'payments.dlq',
      'payments.dlq.classic',
      'triage.manual',
    ]);
  });

  it('searches queues by name', async () => {
    const res = await app.get('/api/profiles/local/vhosts/%2F/queues?search=PAYMENTS');
    expect(names(res.body.queues)).toEqual(['payments.dlq', 'payments.dlq.classic', 'payments.work']);
  });

  it('switches vhost without restarting', async () => {
    const res = await app.get('/api/profiles/local/vhosts/other/queues');
    expect(res.status).toBe(200);
    expect(names(res.body.queues)).toEqual(['other.dlq']);
  });
});
