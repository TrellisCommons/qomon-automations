import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    environment: 'node',
    // DB-backed tests share one Postgres; run files serially to keep the
    // schema deterministic.
    fileParallelism: false,
    hookTimeout: 60_000,
    testTimeout: 20_000,
    globalSetup: ['src/test/global-setup.ts'],
  },
});
