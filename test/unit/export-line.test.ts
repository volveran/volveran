// A held Message as a line of a Checkout's NDJSON export, and the export's file name.
import { describe, expect, it } from 'vitest';
import { exportFilename, exportLine } from '../../src/server/triage/export-line.js';

const classic = { type: 'classic' as const, deliveryLimit: null, deadLetterExchange: false };

describe('exportLine', () => {
  it('keeps 64-bit integers, byte arrays and $-keyed tables lossless', () => {
    const line = exportLine(
      4,
      {
        fields: { exchange: 'dlx', routingKey: 'orders.created', redelivered: false },
        properties: { messageId: 'm-1', contentType: undefined, headers: { big: 2n ** 63n - 1n, raw: Buffer.from('hi'), t: { $x: 1 } } },
        content: Buffer.from('{"a":1}'),
      },
      classic,
      { kind: 'replay' },
    );
    expect(line).toEqual({
      v: 1,
      position: 4,
      messageId: 'm-1',
      exchange: 'dlx',
      routingKey: 'orders.created',
      properties: { messageId: 'm-1' },
      headers: { big: { $bigint: '9223372036854775807' }, raw: { $bytes: 'aGk=' }, t: { $table: { $x: 1 } } },
      body: 'eyJhIjoxfQ==',
      bodyKind: 'json',
      xDeath: [],
      deliveryBudget: null,
      decision: { kind: 'replay' },
      diedAgain: null,
    });
  });

  it('carries the replay id of a Died Again Message, and null for one Volverán never sent out', () => {
    const line = (headers: Record<string, unknown>) =>
      exportLine(
        1,
        { fields: { exchange: '', routingKey: 'orders', redelivered: false }, properties: { headers }, content: Buffer.from('x') },
        classic,
        { kind: 'keep' },
      ).diedAgain;
    expect(line({ 'x-volveran-replay-id': 'r-1' })).toEqual({ replayId: 'r-1' });
    expect(line({ 'x-volveran-replay-id': Buffer.from('r-2') })).toEqual({ replayId: 'r-2' });
    expect(line({ 'x-volveran-replay-id': '' })).toBeNull();
    expect(line({})).toBeNull();
  });
});

describe('exportFilename', () => {
  it('names the profile, queue and UTC time, with unsafe characters replaced', () => {
    expect(exportFilename('prod', 'orders.dlq', new Date('2026-10-28T17:46:00.123Z'))).toBe(
      'volveran-prod-orders.dlq-20261028T174600Z.ndjson',
    );
    expect(exportFilename('eu prod', 'a/b"c', new Date('2026-01-02T03:04:05Z'))).toBe(
      'volveran-eu_prod-a_b_c-20260102T030405Z.ndjson',
    );
  });
});
