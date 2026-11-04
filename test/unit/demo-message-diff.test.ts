// The demo's Message diff (site/demo/api/simulator/message-diff.ts) is a
// Buffer-free mirror of the server's: on the same two Messages, both give the
// same diff.
import { describe, expect, it } from 'vitest';
import { diffMessages as demoDiff, type ComparableMessage } from '../../site/demo/api/simulator/message-diff.js';
import { diffMessages as serverDiff } from '../../src/server/triage/message-diff.js';
import type { RenderedBody } from '../../src/shared/checkout.js';

function message(body: RenderedBody, headers: Record<string, unknown> = {}): ComparableMessage {
  return {
    properties: { messageId: 'm-1', contentType: 'application/json' },
    headers,
    xDeath: [{ queue: 'orders.work', reason: 'rejected', count: 1, time: '2026-10-29T06:23:20.000Z', exchange: 'orders', routingKeys: ['orders.created.eu'], originalExpiration: null }],
    body,
    failureDetails: null,
  };
}

const json = (text: string): RenderedBody => ({ kind: 'json', size: text.length, text });
const text = (t: string): RenderedBody => ({ kind: 'text', size: t.length, text: t });
const binary = (hex: string): RenderedBody => ({ kind: 'binary', size: hex.length / 2, hex, base64: '' });

const pairs: Array<[string, ComparableMessage, ComparableMessage]> = [
  ['JSON bodies', message(json('{"a":1,"b":[1,2]}'), { 'x-tenant': 'south' }), message(json('{"a":2,"b":[1]}'), { 'x-tenant': 'north', extra: 1 })],
  ['text bodies', message(text('one\ntwo\nthree')), message(text('one\n2\nthree\nfour'))],
  ['binary bodies differing in the middle', message(binary('0a08d20910ff')), message(binary('0a08d30910ff'))],
  ['binary bodies, one a prefix of the other', message(binary('0a08d2')), message(binary('0a08d20910'))],
  ['equal binary bodies', message(binary('ff007f')), message(binary('ff007f'))],
  ['bodies of different kinds', message(json('{}')), message(binary('00'))],
];

describe('the demo\'s Message diff', () => {
  it.each(pairs)('gives the server\'s diff for %s', (_name, left, right) => {
    expect(demoDiff(left, right)).toEqual(serverDiff(left, right));
  });
});
