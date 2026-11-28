import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

// Runs only the cross-check driver; see cross_check.py.
export default defineConfig({
  root: fileURLToPath(new URL('../..', import.meta.url)),
  test: {
    environment: 'node',
    include: ['tests/fixtures/cross_check.driver.ts'],
    testTimeout: 600_000,
  },
});
