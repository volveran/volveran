import { describe, expect, it } from 'vitest';
import { isLoopback } from '../../src/server/is-loopback.js';

describe('isLoopback', () => {
  it.each([
    'localhost',
    'LOCALHOST',
    '127.0.0.1',
    '127.1.2.3',
    '127.255.255.255',
    '::1',
    '0:0:0:0:0:0:0:1',
    '0000:0000:0000:0000:0000:0000:0000:0001',
    '::ffff:127.0.0.1',
    '::ffff:7f00:1',
  ])('treats %s as localhost only', (host) => {
    expect(isLoopback(host)).toBe(true);
  });

  it.each([
    '0.0.0.0',
    '::',
    '192.168.1.10',
    '128.0.0.1',
    '126.255.255.255',
    '127.corp.example',
    '127.0.0.1.nip.io',
    'my-host',
    '::ffff:192.168.1.10',
    '::2',
    '',
  ])('treats %s as open to the network', (host) => {
    expect(isLoopback(host)).toBe(false);
  });
});
