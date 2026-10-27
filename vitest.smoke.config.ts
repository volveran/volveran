import { defineConfig } from 'vitest/config';

// The kind smoke test drives a real cluster that scripts/kind-smoke.mjs builds
// (npm run test:smoke); its steps build on each other, and pod restarts and
// rollouts take minutes, not seconds.
export default defineConfig({
  test: {
    include: ['test/smoke/**/*.test.ts'],
    fileParallelism: false,
    testTimeout: 360_000,
    hookTimeout: 120_000,
    // A failed step makes the next ones meaningless.
    bail: 1,
  },
});
