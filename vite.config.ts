import { defineConfig } from 'vitest/config';
import type { Plugin } from 'vite';
import preact from '@preact/preset-vite';
import { VitePWA } from 'vite-plugin-pwa';
import {
  BUNDLED_PACKAGES,
  NOTICES_FILE,
  buildNotices,
  packageOfModule,
} from './scripts/third-party-notices.ts';

const APP_NAME = 'PDF Key';
const BRAND_COLOR = '#4655D6';
const LIGHT_BACKGROUND = '#F7F7FB';

/**
 * Content-Security-Policy of the shipped app. It is delivered as a <meta> tag because static
 * hosts such as GitHub Pages cannot send response headers, and only in production builds because
 * the dev server relies on inline scripts and WebSockets.
 *
 * The app talks to nobody: everything is restricted to its own origin.
 */
const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  // 'wasm-unsafe-eval' permits compiling WebAssembly (the PDF engine), not eval().
  "script-src 'self' 'wasm-unsafe-eval'",
  "worker-src 'self' blob:",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'self'",
].join('; ');

function contentSecurityPolicy(): Plugin {
  return {
    name: 'pdfkey:content-security-policy',
    apply: 'build',
    transformIndexHtml: {
      order: 'post',
      handler(html) {
        const meta = `<meta http-equiv="Content-Security-Policy" content="${CONTENT_SECURITY_POLICY}" />`;
        // Directly after the charset declaration: before anything the policy should govern.
        const charset = /<meta\s+charset=[^>]*>/i;
        if (!charset.test(html)) {
          throw new Error('index.html: <meta charset> not found, cannot place the CSP');
        }
        return html.replace(charset, (tag) => `${tag}\n    ${meta}`);
      },
    },
  };
}

/**
 * Ships the third-party notices (scripts/third-party-notices.ts) as a file of the app, so that
 * every copy of the build carries them and they are precached with the rest. The development
 * server answers the same address.
 */
function thirdPartyNotices(): Plugin {
  const root = import.meta.dirname;
  return {
    name: 'pdfkey:third-party-notices',
    generateBundle() {
      this.emitFile({ type: 'asset', fileName: NOTICES_FILE, source: buildNotices(root) });
    },
    configureServer(server) {
      server.middlewares.use((request, response, next) => {
        const pathname = (request.url ?? '').split('?')[0];
        if (pathname !== `${server.config.base}${NOTICES_FILE}`) return next();
        response.setHeader('Content-Type', 'text/plain; charset=utf-8');
        response.end(buildNotices(root));
      });
    },
  };
}

/**
 * Fails the build when a chunk contains code of a package the notices do not cover. One instance
 * per build: the app, the engine's worker, and the service worker.
 */
function noticesCoverBundle(): Plugin {
  const covered: readonly string[] = BUNDLED_PACKAGES;
  return {
    name: 'pdfkey:notices-cover-bundle',
    apply: 'build',
    generateBundle(_options, bundle) {
      const missing = new Set<string>();
      for (const chunk of Object.values(bundle)) {
        if (chunk.type !== 'chunk') continue;
        for (const id of Object.keys(chunk.modules)) {
          const name = packageOfModule(id);
          if (name !== null && !covered.includes(name)) missing.add(name);
        }
      }
      if (missing.size > 0) {
        this.error(
          `The build contains code of ${[...missing].join(', ')}, which ${NOTICES_FILE} does ` +
            'not cover. Add it to BUNDLED_PACKAGES in scripts/third-party-notices.ts.',
        );
      }
    },
  };
}

const pwa = VitePWA({
  // A hand-written worker (src/pwa/sw.ts) into which the precache list is injected.
  strategies: 'injectManifest',
  srcDir: 'src/pwa',
  filename: 'sw.ts',
  // Registration and the update prompt live in src/pwa/register.ts.
  injectRegister: false,
  registerType: 'prompt',
  // The precache glob below covers the icons already.
  includeManifestIcons: false,
  injectManifest: {
    // A classic (non-module) worker script: works in every browser that has service workers.
    rollupFormat: 'iife',
    buildPlugins: { vite: [noticesCoverBundle()] },
    // The complete build output, so the installed app works offline from its first launch:
    // app shell, engine worker bundle, the WebAssembly module, icons.
    globPatterns: ['**/*'],
    globIgnores: [
      '**/node_modules/**/*',
      // Added by the plugin itself, with its own revision.
      'manifest.webmanifest',
      '**/*.map',
      // Only shown by install dialogs and app stores.
      'screenshots/**',
    ],
    // The WebAssembly module is a few megabytes; the default limit is 2 MiB.
    maximumFileSizeToCacheInBytes: 16 * 1024 * 1024,
  },
  manifest: {
    // No `id`: it then defaults to the start URL, which is unique per deployment. An explicit
    // relative id would be resolved against the *origin* (https://user.github.io/) and make
    // every app on that origin that does the same look like one and the same app.
    name: APP_NAME,
    short_name: APP_NAME,
    description:
      'Unlock and lock PDF files right on your device. Nothing is uploaded: files and passwords never leave it.',
    lang: 'en',
    dir: 'ltr',
    // Everything is relative to the manifest, so the app works from any sub-path.
    start_url: './',
    scope: './',
    display: 'standalone',
    theme_color: BRAND_COLOR,
    background_color: LIGHT_BACKGROUND,
    categories: ['productivity', 'utilities', 'security'],
    icons: [
      { src: 'icons/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
      { src: 'icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
      { src: 'icons/icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any' },
      { src: 'icons/maskable-192.png', sizes: '192x192', type: 'image/png', purpose: 'maskable' },
      { src: 'icons/maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
      {
        src: 'icons/monochrome-512.png',
        sizes: '512x512',
        type: 'image/png',
        purpose: 'monochrome',
      },
    ],
    // The richer install dialog of Chrome: `narrow` pictures on Android, `wide` ones on desktop.
    // scripts/generate-screenshots.mjs renders them into public/screenshots/ (kept out of the
    // offline cache above) and checks sizes and form factors against this list.
    screenshots: [
      {
        src: 'screenshots/phone-unlock.png',
        sizes: '1082x2402',
        type: 'image/png',
        form_factor: 'narrow',
        label: 'A protected PDF and the field for its password',
      },
      {
        src: 'screenshots/phone-done.png',
        sizes: '1082x2402',
        type: 'image/png',
        form_factor: 'narrow',
        label: 'The unlocked copy, ready to save or share',
      },
      {
        src: 'screenshots/phone-lock.png',
        sizes: '1082x2402',
        type: 'image/png',
        form_factor: 'narrow',
        label: 'Protecting a PDF with a new password',
      },
      {
        src: 'screenshots/phone-batch.png',
        sizes: '1082x2402',
        type: 'image/png',
        form_factor: 'narrow',
        label: 'Several PDFs unlocked with one password',
      },
      {
        src: 'screenshots/desktop-unlock.png',
        sizes: '1440x900',
        type: 'image/png',
        form_factor: 'wide',
        label: 'Protected PDFs and the field for their password',
      },
      {
        src: 'screenshots/desktop-done.png',
        sizes: '1440x900',
        type: 'image/png',
        form_factor: 'wide',
        label: 'Unlocked copies, ready to save one by one, into a folder or as a ZIP',
      },
      {
        src: 'screenshots/desktop-lock.png',
        sizes: '1440x900',
        type: 'image/png',
        form_factor: 'wide',
        label: 'Protecting PDFs with AES-256, a permissions password and restrictions',
      },
      {
        src: 'screenshots/desktop-batch.png',
        sizes: '1440x900',
        type: 'image/png',
        form_factor: 'wide',
        label: 'A list of PDFs after one password: unlocked, not encrypted, wrong password',
      },
    ],
    shortcuts: [
      {
        name: 'Unlock a PDF',
        short_name: 'Unlock',
        description: 'Remove the password from a PDF',
        url: './?mode=unlock',
        icons: [
          { src: 'icons/shortcut-unlock-96.png', sizes: '96x96', type: 'image/png' },
          { src: 'icons/shortcut-unlock-192.png', sizes: '192x192', type: 'image/png' },
        ],
      },
      {
        name: 'Lock a PDF',
        short_name: 'Lock',
        description: 'Protect a PDF with a password',
        url: './?mode=lock',
        icons: [
          { src: 'icons/shortcut-lock-96.png', sizes: '96x96', type: 'image/png' },
          { src: 'icons/shortcut-lock-192.png', sizes: '192x192', type: 'image/png' },
        ],
      },
    ],
    // "Share" from another app (Android share sheet): the service worker receives this POST
    // (src/pwa/sw.ts) and hands the files to the page (src/pwa/incoming.ts), to the one that is
    // open if the share navigates the window of a running app, as Chrome on Android does. Path
    // and field name are repeated in src/pwa/share-stash.ts; a unit test keeps the two in step.
    share_target: {
      action: './share-target',
      method: 'POST',
      enctype: 'multipart/form-data',
      params: {
        files: [{ name: 'pdfs', accept: ['application/pdf', '.pdf'] }],
      },
    },
    // "Open with" on desktop: files arrive through window.launchQueue (src/pwa/incoming.ts).
    file_handlers: [{ action: './', accept: { 'application/pdf': ['.pdf'] } }],
    // Desktop Chromium: opening a file with the app, or one of its shortcuts, while it is running
    // re-uses its window instead of loading the app again over the list. The price: for a share
    // to the running app the window is only focused and the files are sent nowhere; the page
    // says so (src/pwa/incoming.ts). Chrome on Android does not look at this for an installed
    // app and navigates its window.
    launch_handler: { client_mode: 'focus-existing' },
  },
});

// `base: './'` keeps every URL relative so the app works from any sub-path
// (GitHub Pages project sites, a custom domain, or a local static server).
export default defineConfig({
  base: './',
  plugins: [preact(), pwa, contentSecurityPolicy(), thirdPartyNotices(), noticesCoverBundle()],
  optimizeDeps: {
    // The dev server looks for dependencies to pre-bundle in every HTML file under the root.
    // The app has one page; the others (engine/browser-check/app) belong to tools with their own
    // Vite configuration and aliases.
    entries: ['index.html'],
  },
  build: {
    target: 'es2022',
    sourcemap: false,
    chunkSizeWarningLimit: 4096,
  },
  worker: {
    format: 'es',
    plugins: () => [noticesCoverBundle()],
  },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx', 'tests/unit/**/*.test.ts'],
    testTimeout: 60_000,
  },
});
