// The sampler against a stand-in management API: what it does when the API
// lists a queue with no depth, as it does just after a broker restart
// (docs/rabbitmq-behaviour.md, "Queue counts").
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { AuditStore } from '../../src/server/audit/store.js';
import { QueueSampler, type FinishedRun, type SamplerControl } from '../../src/server/history/sampler.js';
import { parseProfilesFile } from '../../src/server/profiles.js';

const REF = { profile: 'local', vhost: '/', queue: 'a.dlq' };

describe('the sampler, when the management API lists a queue with no depth', () => {
  const cleanups: Array<() => unknown> = [];
  afterEach(async () => {
    for (const clean of cleanups.splice(0).reverse()) await clean();
  });

  /** A management API answering with `state.messages` for its one queue; undefined leaves the field out, as the broker does. */
  async function brokerWith(state: { messages: number | undefined }) {
    const server = http.createServer((req, res) => {
      const path = (req.url ?? '').split('?')[0];
      const body = path === '/api/queues/%2F' ? [{ name: 'a.dlq', type: 'classic', messages: state.messages, consumers: 0 }] : [];
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(body));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    cleanups.push(() => new Promise((resolve) => server.close(resolve)));
    return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  }

  async function samplerOn(managementUrl: string, store: AuditStore) {
    const { profiles } = parseProfilesFile(
      JSON.stringify({ profiles: [{ name: 'local', managementUrl, amqpUrl: 'amqp://127.0.0.1:1', username: 'u', passwordEnv: 'PW', vhosts: ['/'], defaultQueueFilter: '*.dlq' }] }),
      { PW: 'x' },
    );
    let control: SamplerControl | undefined;
    let now = Date.parse('2026-10-30T10:00:00.000Z');
    const sampler = new QueueSampler({
      profiles,
      history: store.async.history,
      intervalMs: 60_000,
      testHooks: { clock: { now: () => new Date(now), setTimer: () => ({ cancel() {} }) }, sampler: (c) => (control = c) },
    });
    await sampler.start();
    cleanups.push(() => sampler.stop());
    const finished: FinishedRun[] = [];
    sampler.onRun((run) => void finished.push(run));
    const sample = async (at: number) => {
      now = at;
      await control!.sampleNow();
      return finished.at(-1)!;
    };
    return { sample, latest: () => control!.latest() };
  }

  const T0 = Date.parse('2026-10-30T10:00:00.000Z');
  const minute = (n: number) => T0 + n * 60_000;

  function fresh() {
    const store = new AuditStore();
    cleanups.push(() => store.close());
    return store;
  }
  const stored = (store: AuditStore) => store.history.samples(REF, 0, Number.MAX_SAFE_INTEGER).map((s) => [s.depth, s.estimatedArrivals]);

  it('records no Sample in that run, which still counts as good, and says which queue had no depth', async () => {
    const state = { messages: 5 as number | undefined };
    const store = fresh();
    const { sample } = await samplerOn(await brokerWith(state), store);
    await sample(minute(1));
    state.messages = undefined;
    const run = await sample(minute(2));
    expect(run.samplingRun.ok).toBe(true);
    expect(run.samples).toEqual([]);
    expect(run.unknownDepth).toEqual([{ vhost: '/', queue: 'a.dlq' }]);
    expect(stored(store)).toEqual([[5, null]]);
  });

  it('makes the next Sample\'s arrivals unknown, so the depth coming back is no spike', async () => {
    const state = { messages: 5 as number | undefined };
    const store = fresh();
    const { sample } = await samplerOn(await brokerWith(state), store);
    await sample(minute(1));
    state.messages = undefined;
    await sample(minute(2));
    state.messages = 8;
    const next = await sample(minute(3));
    expect(next.samples[0]).toMatchObject({ depth: 8, previousDepth: null, takenOut: 0, estimatedArrivals: null });
    state.messages = 9;
    expect((await sample(minute(4))).samples[0]).toMatchObject({ previousDepth: 8, estimatedArrivals: 1 });
  });

  it('knows that across a restart of Volverán, from the store', async () => {
    const state = { messages: 5 as number | undefined };
    const store = fresh();
    const url = await brokerWith(state);
    const before = await samplerOn(url, store);
    await before.sample(minute(1));
    state.messages = undefined;
    await before.sample(minute(2));
    state.messages = 8;
    const after = await samplerOn(url, store);
    expect((await after.sample(minute(3))).samples[0]).toMatchObject({ previousDepth: null, estimatedArrivals: null });
  });

  it('does not make arrivals unknown after a failed run, when no good run missed the queue', async () => {
    const state = { messages: 5 as number | undefined };
    const store = fresh();
    const { sample } = await samplerOn(await brokerWith(state), store);
    await sample(minute(1));
    store.history.recordRun('local', { at: minute(2), ok: false, errorCode: 'broker_unreachable', intervalMs: 60_000 }, []);
    state.messages = 7;
    expect((await sample(minute(3))).samples[0]).toMatchObject({ previousDepth: 5, estimatedArrivals: 2 });
  });

  it('keeps the queue\'s latest Sample in the snapshot, as a failed run does', async () => {
    const state = { messages: 5 as number | undefined };
    const { sample, latest } = await samplerOn(await brokerWith(state), fresh());
    await sample(minute(1));
    state.messages = undefined;
    await sample(minute(2));
    expect(latest().profiles[0]!.queues.map((q) => [q.queue, q.depth, q.at.getTime()])).toEqual([['a.dlq', 5, minute(1)]]);
  });
});
