// The screenshot seed (scripts/screenshots/seed.mjs) publishes the scenario's
// Message definitions (scripts/screenshots/messages.mjs), which the demo's
// simulator also starts from: run against a stand-in broker, it publishes
// each one, in order, as defined.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { scenarioMessages } from '../../scripts/screenshots/messages.mjs';

interface Published {
  exchange: string;
  routingKey: string;
  content: Buffer;
  options: Record<string, unknown>;
}

const published: Published[] = [];

vi.mock('amqplib', () => ({
  default: {
    connect: async () => ({
      createConfirmChannel: async () => ({
        publish: (exchange: string, routingKey: string, content: Buffer, options: Record<string, unknown>) => {
          published.push({ exchange, routingKey, content, options });
          return true;
        },
        waitForConfirms: async () => {},
        get: async () => false,
        nack: () => {},
      }),
      close: async () => {},
    }),
  },
}));

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('the screenshot seed', () => {
  it('publishes every Message of the scenario, in order, as the data module defines it', async () => {
    vi.stubEnv('VOLVERAN_TEST_MGMT_PORT', '1');
    vi.stubEnv('VOLVERAN_TEST_AMQP_PORT', '2');
    vi.stubGlobal('fetch', async () => new Response('[]'));
    vi.spyOn(console, 'log').mockImplementation(() => {});

    // A path the type checker does not follow: seed.mjs is a plain script, not typed.
    const seed = new URL('../../scripts/screenshots/seed.mjs', import.meta.url).href;
    await import(seed);

    const expected = scenarioMessages();
    expect(published.map((p) => ({ exchange: p.exchange, routingKey: p.routingKey, content: [...p.content], options: p.options }))).toEqual(
      expected.map((m) => ({ exchange: m.exchange, routingKey: m.routingKey, content: [...m.content], options: m.properties })),
    );
    expect(published.every((p) => Buffer.isBuffer(p.content))).toBe(true);
  }, 10_000);
});

describe("the scenario's Messages", () => {
  const messages = scenarioMessages();

  it('are 15 orders (one protobuf) and 6 payments, with message ids counted across all', () => {
    expect(messages.map((m) => m.exchange)).toEqual([...Array(15).fill('orders'), ...Array(6).fill('payments')]);
    expect(messages[0]!.properties.messageId).toBe('ord-7d09-0001');
    expect(messages[14]!.properties.messageId).toBe('ord-22e1b-0015');
    expect(messages[20]!.properties.messageId).toBe('pay-2e7b5-0021');
  });

  it('give every third order Spring AMQP Failure Details naming SQLTimeoutException', () => {
    const timeouts = messages.flatMap((m, i) =>
      String(m.properties.headers?.['x-exception-message'] ?? '').includes('SQLTimeoutException') ? [i] : [],
    );
    expect(timeouts).toEqual([0, 3, 6, 9, 12]);
  });

  it('carry one protobuf order as 26 raw bytes', () => {
    const protobuf = messages[14]!;
    expect(protobuf.properties.contentType).toBe('application/x-protobuf');
    expect(Buffer.from(protobuf.content).toString('hex')).toBe('0a08d20910011a05455552ff007f220c534b552d41582d313134');
  });

  it('pretty-print the bodies of odd orders, as sent', () => {
    const text = (i: number) => new TextDecoder().decode(messages[i]!.content);
    expect(text(0)).toBe(
      '{"orderId":880210,"customerId":"c-10482","currency":"USD","lines":[{"sku":"SKU-AX-114","qty":1,"unitPrice":19.9}],"placedAt":"2026-10-29T06:10:41.118Z"}',
    );
    expect(text(1).startsWith('{\n  "orderId": 880211,')).toBe(true);
  });
});
