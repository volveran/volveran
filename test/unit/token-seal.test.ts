// Sealing what a shared session store holds: readable only with the key, and only for the row it was sealed for.
import { describe, expect, it } from 'vitest';
import { keySeal } from '../../src/server/token-seal.js';

const secret = 'an-encryption-key-of-at-least-32-characters';

describe('sealing tokens', () => {
  it('opens what it sealed, and the sealed text does not show it', () => {
    const seal = keySeal(secret);
    const sealed = seal.seal('the-refresh-token', 'session-1');
    expect(sealed).not.toContain('the-refresh-token');
    expect(seal.open(sealed, 'session-1')).toBe('the-refresh-token');
  });

  it('seals the same text differently each time', () => {
    const seal = keySeal(secret);
    expect(seal.seal('token', 'session-1')).not.toBe(seal.seal('token', 'session-1'));
  });

  it('opens nothing with another key', () => {
    expect(keySeal(`${secret}-other`).open(keySeal(secret).seal('token', 'session-1'), 'session-1')).toBeNull();
  });

  it("opens nothing sealed for another row, so a row's tokens cannot be copied to another", () => {
    const seal = keySeal(secret);
    expect(seal.open(seal.seal('token', 'session-1'), 'session-2')).toBeNull();
  });

  it('opens nothing that was changed or is not sealed at all', () => {
    const seal = keySeal(secret);
    const sealed = seal.seal('token', 'session-1');
    const flipped = sealed.slice(0, 8) + (sealed[8] === 'A' ? 'B' : 'A') + sealed.slice(9);
    expect(seal.open(flipped, 'session-1')).toBeNull();
    expect(seal.open('plain text', 'session-1')).toBeNull();
  });
});
