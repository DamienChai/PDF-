import { defineConfig } from 'vitest/config';
import type { Plugin } from 'vite';
import preact from '@preact/preset-vite';
import { VitePWA } from 'vite-plugin-pwa';

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
    // SCREENSHOTS: add the store-style screenshots here once they exist, e.g.
    //   { src: 'screenshots/phone-unlock.png', sizes: '1080x2400', type: 'image/png',
    //     form_factor: 'narrow', label: 'Unlock a PDF' },
    //   { src: 'screenshots/desktop.png', sizes: '1920x1200', type: 'image/png',
    //     form_factor: 'wide', label: 'PDF Key on the desktop' },
    // Files go to public/screenshots/ (excluded from the offline cache above).
    screenshots: [],
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
    // (src/pwa/sw.ts) and hands the files to the page (src/pwa/incoming.ts). Path and field name
    // are repeated in src/pwa/share-stash.ts; a unit test keeps the two in step.
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
    // Opening a file or sharing while the app is running re-uses its window.
    launch_handler: { client_mode: 'focus-existing' },
  },
});

// `base: './'` keeps every URL relative so the app works from any sub-path
// (GitHub Pages project sites, a custom domain, or a local static server).
export default defineConfig({
  base: './',
  plugins: [preact(), pwa, contentSecurityPolicy()],
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
