import { defineConfig } from 'vitest/config';

// The chart rendering suite runs `helm template` (Helm must be on PATH) against
// charts/volveran and asserts on the rendered manifests. See test/chart/render.ts.
export default defineConfig({
  test: {
    include: ['test/chart/**/*.test.ts'],
    testTimeout: 30_000,
  },
});
