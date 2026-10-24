import { defineConfig } from 'vitest/config';

// The broker-facts suite checks docs/rabbitmq-behaviour.md against the
// docker-compose test broker. Tests declare their own uniquely named queues,
// but some measure timing (consumer timeouts, management API lag), so files
// run one at a time to keep the broker otherwise idle.
export default defineConfig({
  test: {
    include: ['test/broker-facts/**/*.test.ts'],
    fileParallelism: false,
    testTimeout: 60_000,
    hookTimeout: 30_000,
  },
});
