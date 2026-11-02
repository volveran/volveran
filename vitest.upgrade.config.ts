import { defineConfig } from 'vitest/config';

// test/upgrade/published-upgrade.test.ts: a real upgrade between two published images, to verify
// a release candidate. Not part of any suite, as it pulls images. Run it under the test broker:
//   VOLVERAN_UPGRADE_TO=1.0.0-rc.1 node scripts/test-broker.mjs run -- npx vitest run --config vitest.upgrade.config.ts
export default defineConfig({
  test: {
    include: ['test/upgrade/**/*.test.ts'],
    fileParallelism: false,
    testTimeout: 60_000,
    hookTimeout: 180_000,
  },
});
