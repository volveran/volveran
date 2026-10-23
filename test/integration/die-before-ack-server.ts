// Test helper process for apply.test.ts: the real server, killed (SIGKILL) by
// itself right after an Apply step's Audit Entry is committed and before the
// step touches the broker, i.e. between the store write and the ack of a
// Discard. Configured like main.ts through VOLVERAN_* variables; prints
// "listening on <url>".
import { startServer } from '../../src/server/server.js';

const server = await startServer({
  profilesFile: process.env.VOLVERAN_PROFILES_FILE!,
  env: process.env,
  host: '127.0.0.1',
  port: 0,
  dataDir: process.env.VOLVERAN_DATA_DIR!,
  checkoutTestHooks: {
    beforeApplyStep: async () => {
      process.kill(process.pid, 'SIGKILL');
      await new Promise(() => {});
    },
  },
});
console.log(`listening on ${server.url}`);
