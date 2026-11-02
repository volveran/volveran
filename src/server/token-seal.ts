// What a session store holds of an Operator's tokens and of a sign-in in progress.
// On PostgreSQL it is sealed with a key from VOLVERAN_SESSION_ENCRYPTION_KEY, so a
// database dump hands out no token (AES-256-GCM, a new IV each time). A sealed text
// is bound to its row, so one cannot be copied onto another. In memory there is no
// rest to protect, so nothing is sealed.
import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto';

export interface TokenSeal {
  /** `text`, unreadable without the key, for the row `row` only. */
  seal(text: string, row: string): string;
  /** What `seal` was given; null for anything sealed with another key, for another row, or changed since. */
  open(sealed: string, row: string): string | null;
}

/** For a store that keeps nothing at rest. */
export const noSeal: TokenSeal = {
  seal: (text) => text,
  open: (sealed) => sealed,
};

const IV_BYTES = 12;
const TAG_BYTES = 16;

export function keySeal(secret: string): TokenSeal {
  const key = Buffer.from(hkdfSync('sha256', secret, Buffer.alloc(0), 'volveran session tokens v1', 32));
  return {
    seal(text, row) {
      const iv = randomBytes(IV_BYTES);
      const cipher = createCipheriv('aes-256-gcm', key, iv).setAAD(Buffer.from(row));
      const body = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
      return Buffer.concat([iv, cipher.getAuthTag(), body]).toString('base64url');
    },
    open(sealed, row) {
      const bytes = Buffer.from(sealed, 'base64url');
      if (bytes.length < IV_BYTES + TAG_BYTES) return null;
      try {
        const decipher = createDecipheriv('aes-256-gcm', key, bytes.subarray(0, IV_BYTES)).setAAD(Buffer.from(row));
        decipher.setAuthTag(bytes.subarray(IV_BYTES, IV_BYTES + TAG_BYTES));
        return Buffer.concat([decipher.update(bytes.subarray(IV_BYTES + TAG_BYTES)), decipher.final()]).toString('utf8');
      } catch {
        return null;
      }
    },
  };
}
