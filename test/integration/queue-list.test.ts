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
    expect(byName['orders.dlq.quorum'].setupWarning).toEqual({
      code: 'messages_dropped_at_delivery_limit',
      deliveryLimit: 20,
      message: expect.stringMatching(/default delivery-limit \(20\).*dropped.*delivery-limit = -1.*dead-letter exchange/is),
    });
    expect(byName['orders.dlq.quorum-dlx'].setupWarning).toBeNull();
    expect(byName['payments.dlq'].setupWarning).toMatchObject({ deliveryLimit: 5 });
    expect(byName['payments.work'].setupWarning).toBeNull();
    expect(byName['orders.dlq'].setupWarning).toBeNull();
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
        expect(res.body.queues.map((q: any) => q.setupWarning?.deliveryLimit)).toEqual([20, 20]);
      }, 20_000, 500);

      for (const [name, { pattern, definition }] of Object.entries(policies)) {
        const put = await management(`/policies/${vhost}/${name}`, { method: 'PUT', body: { pattern, 'apply-to': 'queues', definition } });
        expect(put.status).toBeLessThan(300);
      }
      await eventually(async () => {
        const res = await filtered.get('/api/profiles/setupcheck/vhosts/%2F/queues?search=setupcheck');
        expect(res.body.queues.map((q: any) => [q.name, q.setupWarning])).toEqual([
          ['setupcheck.dlx.dlq', null],
          ['setupcheck.unlimited.dlq', null],
        ]);
      }, 20_000, 500);
    } finally {
      await filtered.close();
      for (const name of Object.keys(policies)) await management(`/policies/${vhost}/${name}`, { method: 'DELETE' });
      for (const q of queues) await management(`/queues/${vhost}/${q}`, { method: 'DELETE' });
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
