import { defineConfig } from 'vitest/config';
export default defineConfig({
  test: {
    include: ['apps/**/test/**/*.test.ts', 'packages/**/test/**/*.test.ts'],
    testTimeout: 30000,
  },
  resolve: {
    alias: {
      '@harbor/contracts': new URL('./packages/contracts/src/index.ts', import.meta.url).pathname,
      '@harbor/api-client': new URL('./packages/api-client/src/index.ts', import.meta.url).pathname,
    },
  },
});
