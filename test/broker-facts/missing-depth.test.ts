// docs/rabbitmq-behaviour.md, "Missing depth": what the sampler reads from the
// management API's queue list when the broker has no statistics for a queue yet.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import { composeFile, repoRoot, testBrokerSettings } from '../../scripts/test-broker-env.mjs';
import { eventually, management, sleep, uniqueName } from '../broker/client.js';
import { queueTypes, scratch, scratchFor } from './support.js';

/** The queue's row in the list the sampler reads, or null while the API cannot answer. */
async function listed(q: string): Promise<Record<string, unknown> | null> {
  const res = await management('/queues/%2F?columns=name,type,messages,consumers').catch(() => null);
  if (!res || res.status !== 200 || !Array.isArray(res.body)) return null;
  return res.body.find((row: any) => row.name === q) ?? null;
}

async function restartBroker(): Promise<void> {
  const { project } = testBrokerSettings(repoRoot, process.env);
  const ctl = (command: string) =>
    promisify(execFile)('docker', ['compose', '-p', project, '-f', composeFile, 'exec', '-T', 'rabbitmq', 'rabbitmqctl', command]);
  await ctl('stop_app');
  await ctl('start_app');
}

describe('Missing depth', () => {
  describe('A queue just declared is listed with no `messages` or `consumers` fields, rather than zero, until the next statistics emission.', () => {
    it('leaves the fields out, then shows them', async (ctx) => {
      const s = await scratchFor(ctx);
      const q = await s.queue('md-new');
      const row = await eventually(async () => {
        const found = await listed(q);
        if (!found) throw new Error(`${q} not listed yet`);
        return found;
      }, 5_000, 20);
      expect(row).not.toHaveProperty('messages');
      expect(row).not.toHaveProperty('consumers');
      await eventually(async () => expect((await listed(q))?.messages).toBe(0), 15_000, 250);
    });
  });

  describe('Just after a broker restart the management API lists a queue with no `messages` or `consumers` fields, rather than zero, for some seconds. The depth then comes back unchanged.', () => {
    it.for(queueTypes)('a durable %s queue', { timeout: 90_000 }, async (type) => {
      // Not `s.queue`: closing the Scratch before the restart would delete it.
      const s = await scratch();
      const q = uniqueName(`md-${type}`);
      await s.ch.assertQueue(q, { durable: true, arguments: { 'x-queue-type': type } });
      await s.publish(q, ['a', 'b', 'c'], { persistent: true });
      await eventually(async () => expect((await listed(q))?.messages).toBe(3), 30_000, 250);
      await s.close();

      await restartBroker();
      let firstRow: Record<string, unknown> | null = null;
      const startedAt = Date.now();
      while (!firstRow && Date.now() - startedAt < 30_000) {
        firstRow = await listed(q);
        if (!firstRow) await sleep(100);
      }
      expect(firstRow).not.toBeNull();
      expect(firstRow).not.toHaveProperty('messages');
      await eventually(async () => expect((await listed(q))?.messages).toBe(3), 30_000, 250);

      await management(`/queues/%2F/${encodeURIComponent(q)}`, { method: 'DELETE' });
    });
  });
});
