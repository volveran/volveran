// The limits on Checkouts hold across Replicas (#92): one per Operator, one per queue, and
// the queue list says the same through each. Asserted through what an Operator sees.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eventually, purgeQueues, seedMessages, testProfile, withChannel } from './harness.js';
import { startTwoReplicas, type Replica, type ReplicaBrowser, type TwoReplicas } from './two-replicas.js';

const QUEUE = 'limits.orders.dlq';
const OTHER_QUEUE = 'limits.payments.dlq';
const ana = { sub: 'ana-sub', email: 'ana@example.com', groups: ['ops'] };
const ben = { sub: 'ben-sub', email: 'ben@example.com', groups: ['ops'] };
const startPath = (queue: string) => `/api/profiles/dev/vhosts/%2F/queues/${queue}/checkouts`;
const listPath = '/api/profiles/dev/vhosts/%2F/queues';
const profile = () => testProfile({ name: 'dev', roles: { operator: ['ops'] } });

async function resetQueues(): Promise<void> {
  await withChannel('/', async (ch) => {
    await ch.assertQueue(QUEUE, { durable: true });
    await ch.assertQueue(OTHER_QUEUE, { durable: true });
  });
  await purgeQueues('/', [QUEUE, OTHER_QUEUE]);
}

interface Held {
  id: string;
  owner: Replica;
  on: ReplicaBrowser;
}

describe('Checkout limits across Replicas', () => {
  let replicas: TwoReplicas;
  let anaBrowser: ReplicaBrowser;
  let benBrowser: ReplicaBrowser;
  /** Set by a test to hold a start on Replica `a` once it has the queue's lock. */
  let holdAfterLock: Promise<void> | null = null;
  /** Called when a start reaches that hold. */
  let reachedLock: (() => void) | null = null;
  const held: Held[] = [];

  const start = async (on: ReplicaBrowser, owner: Replica, queue = QUEUE): Promise<string> => {
    const answer = await on.to(owner).post(startPath(queue), {});
    expect(answer.status).toBe(201);
    const { id } = answer.body.checkout as { id: string };
    held.push({ id, owner, on });
    return id;
  };

  beforeAll(async () => {
    await resetQueues();
    replicas = await startTwoReplicas({
      profiles: [profile()],
      perReplica: (name) =>
        name === 'a'
          ? {
              checkoutTestHooks: {
                afterLock: async () => {
                  reachedLock?.();
                  await holdAfterLock;
                },
              },
            }
          : {},
    });
    anaBrowser = replicas.browser();
    await anaBrowser.signIn(ana);
    benBrowser = replicas.browser();
    await benBrowser.signIn(ben);
  });
  afterAll(async () => {
    await replicas?.close();
  });
  beforeEach(async () => {
    await seedMessages('/', QUEUE, 1);
    await seedMessages('/', OTHER_QUEUE, 1);
  });
  afterEach(async () => {
    for (const { id, owner, on } of held.splice(0)) await on.to(owner).post(`/api/checkouts/${id}/end`);
    await purgeQueues('/', [QUEUE, OTHER_QUEUE]);
  });

  it.each(['a', 'b'] as const)('refuses an Operator a second Checkout on the other Replica, when the first is on %s', async (name) => {
    const owner = replicas[name];
    const id = await start(anaBrowser, owner);
    const second = await anaBrowser.to(replicas.other(owner)).post(startPath(OTHER_QUEUE), {});
    expect(second.status).toBe(409);
    expect(second.body.error).toMatchObject({ code: 'operator_has_checkout', checkoutId: id, vhost: '/', queue: QUEUE });
    expect(second.body.error.message).toContain(`"${QUEUE}"`);
  });

  it('refuses a second Checkout on the other Replica while the first is still starting', async () => {
    let letGo = () => {};
    holdAfterLock = new Promise<void>((resolve) => (letGo = resolve));
    const reached = new Promise<void>((resolve) => (reachedLock = resolve));
    const first = anaBrowser.to(replicas.a).post(startPath(QUEUE), {});
    try {
      await reached;
      const second = await anaBrowser.to(replicas.b).post(startPath(OTHER_QUEUE), {});
      expect(second.status).toBe(409);
      expect(second.body.error).toMatchObject({ code: 'operator_has_checkout', queue: QUEUE });
    } finally {
      letGo();
      holdAfterLock = null;
      reachedLock = null;
    }
    const answer = await first;
    expect(answer.status).toBe(201);
    held.push({ id: answer.body.checkout.id as string, owner: replicas.a, on: anaBrowser });
  });

  it("lets only one of an Operator's starts at once win, through different Replicas", async () => {
    const answers = await Promise.all([
      anaBrowser.to(replicas.a).post(startPath(QUEUE), {}),
      anaBrowser.to(replicas.b).post(startPath(OTHER_QUEUE), {}),
    ]);
    answers.forEach((answer, i) => {
      if (answer.status === 201) held.push({ id: answer.body.checkout.id as string, owner: i === 0 ? replicas.a : replicas.b, on: anaBrowser });
    });
    expect(answers.map((a) => a.status).sort()).toEqual([201, 409]);
    expect(answers.find((a) => a.status === 409)?.body.error.code).toBe('operator_has_checkout');
  });

  it('lets an Operator start on the other Replica as soon as their Checkout has ended', async () => {
    for (let i = 0; i < 3; i++) {
      await seedMessages('/', QUEUE, 1);
      const owner = i % 2 ? replicas.b : replicas.a;
      const id = await start(anaBrowser, owner);
      expect((await anaBrowser.to(owner).post(`/api/checkouts/${id}/end`)).status).toBe(200);
      held.pop();
      const next = await start(anaBrowser, replicas.other(owner), OTHER_QUEUE);
      expect((await anaBrowser.to(replicas.other(owner)).post(`/api/checkouts/${next}/end`)).status).toBe(200);
      held.pop();
    }
  });

  it('lets an Operator start on the other Replica right after a start that failed', async () => {
    const failed = await anaBrowser.to(replicas.a).post(startPath('limits.no-such-queue'), {});
    expect(failed.status).toBe(404);
    await start(anaBrowser, replicas.b);
  });

  it('keeps the limit per Operator: two Operators each hold one', async () => {
    await start(anaBrowser, replicas.a, QUEUE);
    await start(benBrowser, replicas.b, OTHER_QUEUE);
  });

  it('lets one of two Operators racing for a queue through different Replicas win, and names them to the other', async () => {
    for (let round = 0; round < 3; round++) {
      await seedMessages('/', QUEUE, 1);
      const [first, second] = await Promise.all([
        anaBrowser.to(replicas.a).post(startPath(QUEUE), {}),
        benBrowser.to(replicas.b).post(startPath(QUEUE), {}),
      ]);
      expect([first.status, second.status].sort()).toEqual([201, 409]);
      const anaWon = first.status === 201;
      const [won, lost] = anaWon ? [first, second] : [second, first];
      expect(lost.body.error.code).toBe('checkout_in_progress');
      expect(lost.body.error.holder.operator).toBe(anaWon ? ana.email : ben.email);
      const owner = anaWon ? replicas.a : replicas.b;
      const winner = anaWon ? anaBrowser : benBrowser;
      // Losing the queue holds nothing: the loser may take another at once.
      const loser = anaWon ? benBrowser : anaBrowser;
      const elsewhere = await start(loser, replicas.other(owner), OTHER_QUEUE);
      expect((await loser.to(replicas.other(owner)).post(`/api/checkouts/${elsewhere}/end`)).status).toBe(200);
      held.pop();
      await seedMessages('/', OTHER_QUEUE, 1);
      expect((await winner.to(owner).post(`/api/checkouts/${won.body.checkout.id as string}/end`)).status).toBe(200);
    }
  });

  it('shows the same queue list through either Replica, with every Checkout and its holder', async () => {
    await start(anaBrowser, replicas.a, QUEUE);
    await start(benBrowser, replicas.b, OTHER_QUEUE);
    const holders = async (on: ReplicaBrowser, replica: Replica) => {
      const list = await on.to(replica).get(listPath);
      expect(list.status).toBe(200);
      const queues = list.body.queues as Array<{ name: string; checkedOutBy: { operator: string; since: string } | null }>;
      return Object.fromEntries(queues.filter((q) => q.name === QUEUE || q.name === OTHER_QUEUE).map((q) => [q.name, q.checkedOutBy]));
    };
    await eventually(async () => {
      const fromA = await holders(anaBrowser, replicas.a);
      expect(fromA).toEqual({
        [QUEUE]: { operator: ana.email, since: expect.any(String) },
        [OTHER_QUEUE]: { operator: ben.email, since: expect.any(String) },
      });
      expect(await holders(anaBrowser, replicas.b)).toEqual(fromA);
      expect(await holders(benBrowser, replicas.b)).toEqual(fromA);
    });
  });
});

it('frees an Operator on the other Replica once the Owner Replica has crashed and its lease is over', async () => {
  await resetQueues();
  const replicas = await startTwoReplicas({ profiles: [profile()], replicaLeaseTiming: { renewEveryMs: 100, holdsForMs: 400 } });
  try {
    const browser = replicas.browser();
    await browser.signIn(ana);
    await seedMessages('/', QUEUE, 1);
    await seedMessages('/', OTHER_QUEUE, 1);
    expect((await browser.to(replicas.a).post(startPath(QUEUE), {})).status).toBe(201);
    expect((await browser.to(replicas.b).post(startPath(OTHER_QUEUE), {})).status).toBe(409);
    await replicas.a.crash();
    let id = '';
    await eventually(async () => {
      const next = await browser.to(replicas.b).post(startPath(OTHER_QUEUE), {});
      expect(next.status).toBe(201);
      id = next.body.checkout.id as string;
    });
    await browser.to(replicas.b).post(`/api/checkouts/${id}/end`);
  } finally {
    await replicas.close();
    await purgeQueues('/', [QUEUE, OTHER_QUEUE]);
  }
});
