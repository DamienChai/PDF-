import { defineConfig } from 'vitest/config';
import preact from '@preact/preset-vite';

// `base: './'` keeps every URL relative so the app works from any sub-path
// (GitHub Pages project sites, a custom domain, or a local static server).
export default defineConfig({
  base: './',
  plugins: [preact()],
  build: {
    target: 'es2022',
    sourcemap: false,
    chunkSizeWarningLimit: 4096,
  },
  worker: {
    format: 'es',
  },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx', 'tests/unit/**/*.test.ts'],
    testTimeout: 60_000,
  },
});
