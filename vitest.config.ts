import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    testTimeout: 15_000,
    exclude: [
      '**/node_modules/**',
      '**/dist/**',
      '**/packages/web-ui/tests/e2e/**',
    ],
  },
});
