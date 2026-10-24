import { defineConfig } from 'vitest/config';

// Integration tests share one broker (per worktree) with a fixed topology, so
// test files run one at a time. See README "Development".
export default defineConfig({
  test: {
    include: ['test/integration/**/*.test.ts'],
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
