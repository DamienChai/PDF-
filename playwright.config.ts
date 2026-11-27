import { defineConfig, devices } from '@playwright/test';
import { PREVIEW_PORT, PREVIEW_URL, SUBPATH, SUBPATH_PORT } from './tests/e2e/support/servers';

/**
 * End-to-end tests of the production build with the real WebAssembly engine.
 *
 *   npm run e2e                         everything
 *   npm run e2e -- --project=phone      one project (phone, desktop, layout)
 *   npm run e2e -- unlock               one file
 *
 * Two servers are started (and stopped) by Playwright:
 *   - `vite preview` of a fresh `npm run build` at the root of port 4173: what most tests use;
 *   - a static server that mimics a GitHub Pages project site (the same build under /PDF-/,
 *     404 for everything else, 405 for POST) on port 5173, for tests/e2e/pwa.spec.ts.
 *
 * Set E2E_REUSE_SERVERS=1 to use servers that are already running (the build is then whatever
 * they serve).
 */
const reuseExistingServer = process.env.E2E_REUSE_SERVERS === '1';

/** tests/e2e/layout.spec.ts brings its own devices (see the `layout` project). */
const LAYOUT_MATRIX = /layout\.spec\.ts$/;

/**
 * The browser's environment: a UTF-8 locale, as on any real device. Without one Chromium cannot
 * turn a download name such as "已解锁的 PDF.zip" into a file name and calls the file "download".
 */
const browserEnvironment: Record<string, string> = { LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8' };
for (const [name, value] of Object.entries(process.env)) {
  if (value !== undefined && !(name in browserEnvironment)) browserEnvironment[name] = value;
}

export default defineConfig({
  testDir: 'tests/e2e',
  testMatch: '**/*.spec.ts',
  outputDir: 'test-results',
  // Downloads of passing tests (some of them 30 MB) are not worth keeping.
  preserveOutput: 'failures-only',
  globalSetup: './tests/e2e/support/global-setup.ts',
  fullyParallel: true,
  // One worker per core (Playwright's default is half of them): the tests mostly wait for the
  // browser, and the suite stays well under two minutes on four cores.
  workers: '100%',
  forbidOnly: !!process.env.CI,
  // A regression net must not hide flakiness behind retries.
  retries: 0,
  reporter: process.env.CI
    ? [['github'], ['list'], ['html', { open: 'never' }]]
    : [['list'], ['html', { open: 'never' }]],
  timeout: 30_000,
  expect: { timeout: 10_000 },
  use: {
    baseURL: PREVIEW_URL,
    trace: 'off',
    screenshot: 'only-on-failure',
    acceptDownloads: true,
    // Off unless a test is about the service worker (tests/e2e/pwa.spec.ts): precaching the
    // whole app in every test would only add load, and the "ready to work offline" toast of a
    // first visit would sit on top of what other tests look at.
    serviceWorkers: 'block',
    launchOptions: { env: browserEnvironment },
  },
  projects: [
    {
      // The primary device: a Pixel phone, Android Chrome, Simplified Chinese.
      name: 'phone',
      testIgnore: LAYOUT_MATRIX,
      use: {
        ...devices['Pixel 7'],
        viewport: { width: 412, height: 915 },
        deviceScaleFactor: 2.625,
        isMobile: true,
        hasTouch: true,
        locale: 'zh-CN',
      },
    },
    {
      // A desktop window (macOS / Windows), mouse and keyboard, English.
      name: 'desktop',
      testIgnore: LAYOUT_MATRIX,
      use: {
        viewport: { width: 1440, height: 900 },
        deviceScaleFactor: 1,
        locale: 'en-US',
      },
    },
    {
      // Layout guards: the spec sets viewport, language and theme itself, one combination per
      // test, so it runs once instead of once per device.
      name: 'layout',
      testMatch: LAYOUT_MATRIX,
    },
  ],
  webServer: [
    {
      command: `npm run build && npx vite preview --host 127.0.0.1 --port ${PREVIEW_PORT} --strictPort`,
      url: PREVIEW_URL,
      reuseExistingServer,
      timeout: 120_000,
      stdout: 'ignore',
      stderr: 'pipe',
    },
    {
      // Serves dist/ lazily, so it does not matter that the build above is still running when
      // it starts: tests begin only when both servers answer.
      command: `node tests/e2e/support/static-server.mjs dist ${SUBPATH_PORT} ${SUBPATH}`,
      url: `http://127.0.0.1:${SUBPATH_PORT}/__ready`,
      reuseExistingServer,
      timeout: 120_000,
      stdout: 'ignore',
      stderr: 'pipe',
    },
  ],
});
