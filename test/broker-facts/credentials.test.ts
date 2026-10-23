// docs/rabbitmq-behaviour.md, "Credentials".
import { describe, expect, it } from 'vitest';
import { openChannel } from '../broker/client.js';
import { scratchFor } from './support.js';

describe('Credentials', () => {
  describe('`update-secret` is accepted even with a wrong password on the internal authentication backend. Its behaviour with the OAuth 2.0 backend is not yet verified.', () => {
    it('update-secret with a wrong password succeeds and the connection keeps working', async (ctx) => {
      const s = await scratchFor(ctx);
      await expect(s.conn.updateSecret(Buffer.from('not-the-password'), 'broker-facts test')).resolves.toBeUndefined();
      const ch = await openChannel(s.conn);
      const q = await s.queue('cred-after-update-secret', { 'x-queue-type': 'classic' });
      expect(await ch.checkQueue(q)).toMatchObject({ messageCount: 0 });
    });
  });
});
