import { defineConfig } from 'vitest/config';

// The sandbox suite hits the real Qomon API and is excluded unless
// QOMON_SANDBOX=1 (see `pnpm test:sandbox`). CI never sets it.
const sandbox = process.env.QOMON_SANDBOX === '1';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    exclude: sandbox ? ['node_modules/**'] : ['src/sandbox.test.ts', 'node_modules/**'],
    environment: 'node',
  },
});
