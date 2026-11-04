// The demo's broker is the screenshot run's broker: the topology of
// test/broker/definitions.json (which the test broker loads), plus the
// set-ups scripts/screenshots/seed.mjs declares.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { SCENARIO_TOPOLOGY } from '../../site/demo/api/simulator/broker.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

interface Definitions {
  queues: Array<{ vhost: string; name: string; arguments: Record<string, unknown> }>;
  exchanges: Array<{ vhost: string; name: string; type: string }>;
  bindings: Array<{ vhost: string; source: string; destination: string; routing_key: string }>;
}

const definitions = JSON.parse(readFileSync(path.join(root, 'test/broker/definitions.json'), 'utf8')) as Definitions;
const seedDeclares = ['billing.work', 'shipping.dlq', 'notifications.dlq', 'inventory.work'];

describe("the demo broker's topology", () => {
  it('has the queues of test/broker/definitions.json with their type and dead-letter exchange, and those seed.mjs declares', () => {
    const demo = SCENARIO_TOPOLOGY.queues.filter((q) => !seedDeclares.includes(q.name));
    expect(demo.map(({ vhost, name, type, deadLetterExchange }) => ({ vhost, name, type, deadLetterExchange }))).toEqual(
      definitions.queues.map((q) => ({
        vhost: q.vhost,
        name: q.name,
        type: q.arguments['x-queue-type'],
        deadLetterExchange: q.arguments['x-dead-letter-exchange'],
      })),
    );
    expect(SCENARIO_TOPOLOGY.queues.find((q) => q.name === 'payments.dlq')?.deliveryLimit).toBe(
      definitions.queues.find((q) => q.name === 'payments.dlq')?.arguments['x-delivery-limit'],
    );
  });

  it('has the exchanges and bindings of test/broker/definitions.json', () => {
    expect(SCENARIO_TOPOLOGY.exchanges.filter((e) => e.name !== 'inventory.dlx')).toEqual(
      definitions.exchanges.map(({ vhost, name, type }) => ({ vhost, name, type })),
    );
    expect(SCENARIO_TOPOLOGY.bindings).toEqual(
      definitions.bindings.map(({ vhost, source, destination, routing_key }) => ({ vhost, source, destination, routingKey: routing_key })),
    );
  });
});
