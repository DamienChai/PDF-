/**
 * What only the production build has: the Content-Security-Policy, the service worker (offline,
 * share target, updates), the manifest and its shortcuts, and life under a sub-path as on
 * GitHub Pages.
 *
 * The fixture of every test already fails on console errors and warnings, CSP violations, failed
 * requests and requests to other origins; here those rules meet the service worker.
 */
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Page } from '@playwright/test';
import { expect, test, type App } from './support/app';
import { fixture, fixturePath, unlockedName } from './support/files';
import { expectUnlockedCopy } from './support/pdf';
import { SUBPATH, SUBPATH_URL, SW_VERSION_COOKIE } from './support/servers';

const DIST = fileURLToPath(new URL('../../dist/', import.meta.url));

interface Manifest {
  name: string;
  start_url: string;
  scope: string;
  display: string;
  icons: { src: string; sizes: string; type: string; purpose?: string }[];
  shortcuts: { name: string; url: string }[];
  share_target: {
    action: string;
    method: string;
    enctype: string;
    params: { files: { name: string; accept: string[] }[] };
  };
  file_handlers: { action: string; accept: Record<string, string[]> }[];
}

/** The manifest the page links to, with the URL it was loaded from. */
async function readManifest(page: Page): Promise<{ url: string; manifest: Manifest }> {
  const href = await page.locator('link[rel="manifest"]').getAttribute('href');
  const url = new URL(href!, page.url()).href;
  const response = await page.request.get(url);
  expect(response.ok()).toBe(true);
  return { url, manifest: (await response.json()) as Manifest };
}

/** Resolves once the service worker controls the page and has everything cached. */
async function controlled(app: App): Promise<void> {
  await app.page.evaluate(async () => {
    await navigator.serviceWorker.ready;
    if (!navigator.serviceWorker.controller) {
      await new Promise((resolve) => {
        navigator.serviceWorker.addEventListener('controllerchange', resolve, { once: true });
      });
    }
  });
}

/** Opens the app for the first time: installs the worker, which announces itself once. */
async function install(app: App, url = './'): Promise<void> {
  await app.open(url);
  await controlled(app);
  await app.expectToast('toast.offlineReady');
}

/** Sends files to the manifest's share target the way the Android share sheet does. */
async function share(page: Page, paths: readonly string[]): Promise<void> {
  const { url, manifest } = await readManifest(page);
  const target = manifest.share_target;
  expect(target.method).toBe('POST');
  expect(target.enctype).toBe('multipart/form-data');
  await page.evaluate(
    ({ action, field }) => {
      const form = document.createElement('form');
      form.id = 'e2e-share';
      form.method = 'post';
      form.enctype = 'multipart/form-data';
      form.action = action;
      const input = document.createElement('input');
      input.type = 'file';
      input.name = field;
      input.multiple = true;
      form.append(input);
      document.body.append(form);
    },
    { action: new URL(target.action, url).href, field: target.params.files[0]!.name },
  );
  await page.locator('#e2e-share input').setInputFiles([...paths]);
  await page.evaluate(() => (document.getElementById('e2e-share') as HTMLFormElement).submit());
}

async function unlockAndVerify(app: App, file: string): Promise<void> {
  const source = fixture(file);
  await app.expectState(file, 'needs-password');
  await app.unlockWith(source.userPassword!);
  await app.expectState(file, 'done');
  const saved = await app.saveAll();
  expect(saved.name).toBe(unlockedName(file));
  await expectUnlockedCopy(saved.bytes, source);
}

test.describe('the production build', () => {
  test('ships a strict Content-Security-Policy and nothing of the development tools', async ({
    app,
    page,
  }) => {
    await app.open('./?fake&demo');
    const policy = await page
      .locator('meta[http-equiv="Content-Security-Policy"]')
      .getAttribute('content');
    expect(policy).toContain("default-src 'self'");
    expect(policy).toContain("script-src 'self' 'wasm-unsafe-eval'");
    expect(policy).toContain("connect-src 'self'");
    expect(policy).toContain("object-src 'none'");
    expect(policy).not.toContain("'unsafe-eval'");
    expect(policy).not.toMatch(/https?:/);
    await expect(page.locator('meta[name="referrer"]')).toHaveAttribute('content', 'no-referrer');

    // `?fake&demo` loads a scripted engine and demo files in development. Not here.
    await expect(app.chooseButton).toBeVisible();
    await expect(app.cards).toHaveCount(0);
    expect(await page.evaluate(() => '__pdfkey' in window)).toBe(false);
    const scripts = readdirSync(path.join(DIST, 'assets')).filter((name) => name.endsWith('.js'));
    expect(scripts.length).toBeGreaterThan(1);
    for (const name of [...scripts.map((script) => `assets/${script}`), 'sw.js', 'boot.js']) {
      const text = readFileSync(path.join(DIST, name), 'utf8');
      expect(text, name).not.toContain('pdfkey-fake-engine-not-for-production');
      expect(text, name).not.toContain('sourceMappingURL');
    }
  });

  test('a complete unlock talks to its own origin only', async ({ app, context, baseURL }) => {
    const requests: string[] = [];
    context.on('request', (request) => requests.push(request.url()));

    await app.open();
    await app.addFixtures('aes-256-r6.pdf');
    await unlockAndVerify(app, 'aes-256-r6.pdf');
    await app.openSettings();
    await expect(app.settings).toContainText('12.4.2');

    const network = requests.filter((url) => !url.startsWith('blob:') && !url.startsWith('data:'));
    // The engine was really fetched (so this list is not empty by accident)…
    expect(network.some((url) => url.endsWith('.wasm'))).toBe(true);
    expect(network.some((url) => /\/assets\/worker-[\w-]+\.js$/.test(url))).toBe(true);
    // …and every single request went to the app's own files.
    expect(network.filter((url) => !url.startsWith(baseURL!))).toEqual([]);
    for (const url of network) {
      expect(new URL(url).search, `${url} carries no query`).toBe('');
    }
  });

  test('the manifest describes an installable app with working icons', async ({ app, page }) => {
    await app.open();
    const { url, manifest } = await readManifest(page);
    expect(manifest.name).toBe('PDF Key');
    expect(manifest.display).toBe('standalone');
    // Relative, so that the app can live under any path.
    expect(manifest.start_url).toBe('./');
    expect(manifest.scope).toBe('./');
    expect(manifest.share_target.action).toBe('./share-target');
    expect(manifest.file_handlers[0]!.accept).toEqual({ 'application/pdf': ['.pdf'] });
    expect(manifest.icons.map((icon) => `${icon.sizes} ${icon.purpose}`)).toEqual(
      expect.arrayContaining([
        '192x192 any',
        '512x512 any',
        '192x192 maskable',
        '512x512 maskable',
      ]),
    );
    for (const icon of manifest.icons) {
      const response = await page.request.get(new URL(icon.src, url).href);
      expect(response.status(), icon.src).toBe(200);
      expect(response.headers()['content-type'], icon.src).toContain(icon.type);
    }
    expect(manifest.shortcuts.map((shortcut) => shortcut.url)).toEqual([
      './?mode=unlock',
      './?mode=lock',
    ]);
  });

  test('the shortcuts of the installed app open the right mode', async ({ app, page }) => {
    await app.open('./?mode=lock');
    await expect(app.modeOption('lock')).toBeChecked();
    await expect(
      page.getByRole('heading', { level: 2, name: app.t('empty.lock.title') }),
    ).toBeVisible();
    await app.addFixtures('plain.pdf');
    await app.expectState('plain.pdf', 'ready', 'lock');
    await expect(app.lockPassword).toBeVisible();

    await app.open('./?mode=unlock');
    await expect(app.modeOption('unlock')).toBeChecked();
    await expect(
      page.getByRole('heading', { level: 2, name: app.t('empty.unlock.title') }),
    ).toBeVisible();

    // Anything else is ignored.
    await app.open('./?mode=shred');
    await expect(app.modeOption('unlock')).toBeChecked();
  });

  test('the install button appears only when the browser offers installation', async ({
    app,
    page,
  }) => {
    await app.open();
    const install = page.getByRole('button', { name: app.t('topbar.install'), exact: true });
    await expect(install).toHaveCount(0);

    // Chromium announces that the app can be installed.
    await page.evaluate(() => {
      const offer = new Event('beforeinstallprompt', { cancelable: true });
      const scope = window as unknown as { e2ePrompted: number };
      scope.e2ePrompted = 0;
      Object.assign(offer, {
        prompt: () => {
          scope.e2ePrompted++;
          return Promise.resolve();
        },
        userChoice: Promise.resolve({ outcome: 'accepted' }),
      });
      window.dispatchEvent(offer);
    });
    await expect(install).toBeVisible();
    const settings = await app.openSettings();
    await expect(settings.getByRole('button', { name: app.t('topbar.install') })).toBeVisible();
    await expect(settings).toContainText(app.t('settings.install.description'));
    await app.closeDialog();

    await install.click();
    await expect(install).toHaveCount(0);
    expect(
      await page.evaluate(() => (window as unknown as { e2ePrompted: number }).e2ePrompted),
    ).toBe(1);
    await app.openSettings();
    await expect(app.settings).toContainText(app.t('settings.install.installed'));
  });

  test('"open with" hands files to the running app, and a shortcut switches its mode', async ({
    app,
    page,
  }) => {
    // The launch queue of an installed app, as far as a browser tab can have one.
    await page.addInitScript(() => {
      const scope = window as unknown as { e2eLaunch?: (params: unknown) => void };
      // Defined, not assigned: where the browser has a launch queue it is read-only.
      Object.defineProperty(window, 'launchQueue', {
        configurable: true,
        value: {
          setConsumer(consumer: (params: unknown) => void) {
            scope.e2eLaunch = consumer;
          },
        },
      });
    });
    await app.open();
    const bytes = readFileSync(fixturePath('aes-256-r6.pdf')).toString('base64');
    await page.evaluate((base64) => {
      const data = Uint8Array.from(atob(base64), (char) => char.charCodeAt(0));
      const file = new File([data], 'opened-with.pdf', { type: 'application/pdf' });
      const scope = window as unknown as { e2eLaunch(params: unknown): void };
      scope.e2eLaunch({ files: [{ kind: 'file', name: file.name, getFile: async () => file }] });
    }, bytes);
    await app.expectState('opened-with.pdf', 'needs-password');

    await page.evaluate(() => {
      const scope = window as unknown as { e2eLaunch(params: unknown): void };
      scope.e2eLaunch({ targetURL: new URL('./?mode=lock', location.href).href });
    });
    await expect(app.modeOption('lock')).toBeChecked();
    await app.expectState('opened-with.pdf', 'encrypted', 'lock');
  });
});

test.describe('service worker', () => {
  test.use({ serviceWorkers: 'allow' });

  test('after the first visit the app works without a network', async ({ app, page, context }) => {
    await install(app);
    const registration = await page.evaluate(async () => {
      const ready = await navigator.serviceWorker.ready;
      return { scope: ready.scope, script: ready.active?.scriptURL };
    });
    expect(registration).toEqual({
      scope: new URL('./', page.url()).href,
      script: new URL('./sw.js', page.url()).href,
    });

    await context.setOffline(true);
    await page.reload();
    await app.ready();
    // "Ready to work offline" is said once per installation, not on every visit.
    await app.addFixtures('aes-256-r6.pdf');
    await unlockAndVerify(app, 'aes-256-r6.pdf');
    await expect(app.toasts).not.toContainText(app.t('toast.offlineReady'));

    // Lock mode, its shortcut, settings and the engine's version: all from the cache.
    await app.open('./?mode=lock');
    await expect(app.modeOption('lock')).toBeChecked();
    await app.addFixtures('plain.pdf');
    await app.expectState('plain.pdf', 'ready', 'lock');
    await app.lockPassword.fill('offline-password');
    await app.lockConfirmation.fill('offline-password');
    await app.lockConfirmation.press('Enter');
    await app.expectState('plain.pdf', 'done', 'lock');
    await app.openSettings();
    await expect(app.settings).toContainText(app.t('about.engine.value', { version: '12.4.2' }));
    expect(await page.evaluate(() => navigator.onLine)).toBe(false);
  });

  test('files shared from another app arrive in the list', async ({ app, page }) => {
    await install(app);
    await share(page, [fixturePath('aes-256-r6.pdf'), fixturePath('owner-only-r6.pdf')]);

    // The worker took the POST, kept the files and sent the browser to the app.
    await app.ready();
    await app.analysed(2);
    await app.expectState('aes-256-r6.pdf', 'needs-password');
    await app.expectState('owner-only-r6.pdf', 'restricted');
    // A clean address: reloading must not look like another share.
    await expect(page).toHaveURL(new URL('./', page.url()).href);
    expect(new URL(page.url()).search).toBe('');
    await unlockAndVerifyBatch(app);

    // Nothing is left behind in the hand-over cache, and a reload starts empty.
    expect(
      await page.evaluate(async () => {
        const names = (await caches.keys()).filter((name) => name.includes('incoming'));
        const counts = await Promise.all(
          names.map(async (name) => (await (await caches.open(name)).keys()).length),
        );
        return counts.reduce((sum, count) => sum + count, 0);
      }),
    ).toBe(0);
    await page.reload();
    await app.ready();
    await expect(app.cards).toHaveCount(0);
  });

  test('a share while offline works too, and a shared non-PDF is turned away', async ({
    app,
    page,
    context,
  }) => {
    await install(app);
    await context.setOffline(true);
    await share(page, [fixturePath('not-a-pdf.bin'), fixturePath('plain.pdf')]);
    await app.ready();
    await app.analysed(1);
    await app.expectState('plain.pdf', 'not-encrypted');
    await app.expectToast('toast.notPdf', { name: 'not-a-pdf.bin' });
  });
});

async function unlockAndVerifyBatch(app: App): Promise<void> {
  await app.unlockWith('user');
  await app.expectState('aes-256-r6.pdf', 'done');
  await app.expectState('owner-only-r6.pdf', 'done');
  await expect(app.dock).toContainText(app.t('status.unlocked', { count: 2 }));
}

test.describe('under a sub-path, as on GitHub Pages', () => {
  test.use({ serviceWorkers: 'allow', baseURL: SUBPATH_URL });

  test('the app, its engine and its worker load from the sub-path only', async ({
    app,
    page,
    context,
  }) => {
    const paths: string[] = [];
    context.on('request', (request) => {
      const url = new URL(request.url());
      if (url.protocol.startsWith('http')) paths.push(url.pathname);
    });

    await install(app);
    expect(page.url()).toBe(SUBPATH_URL);
    const registration = await page.evaluate(async () => {
      const ready = await navigator.serviceWorker.ready;
      return { scope: ready.scope, script: ready.active?.scriptURL };
    });
    expect(registration).toEqual({ scope: SUBPATH_URL, script: `${SUBPATH_URL}sw.js` });

    await app.addFixtures('aes-256-r6.pdf');
    await unlockAndVerify(app, 'aes-256-r6.pdf');

    // Nothing was asked of the root of the origin (which answers 404 here, as it would there).
    expect(paths.some((pathname) => pathname.endsWith('.wasm'))).toBe(true);
    expect(paths.filter((pathname) => !pathname.startsWith(SUBPATH))).toEqual([]);

    const { url, manifest } = await readManifest(page);
    expect(url).toBe(`${SUBPATH_URL}manifest.webmanifest`);
    expect(new URL(manifest.start_url, url).href).toBe(SUBPATH_URL);
    expect(new URL(manifest.scope, url).href).toBe(SUBPATH_URL);
    expect(new URL(manifest.share_target.action, url).href).toBe(`${SUBPATH_URL}share-target`);
  });

  test('offline and the share target work there as well', async ({ app, page, context }) => {
    await install(app);
    await context.setOffline(true);
    await app.open('./?mode=lock');
    await expect(app.modeOption('lock')).toBeChecked();

    // The server would answer this POST with 405: only the worker can take it.
    await share(page, [fixturePath('aes-128-r4.pdf')]);
    await app.ready();
    await expect(page).toHaveURL(SUBPATH_URL);
    await unlockAndVerify(app, 'aes-128-r4.pdf');
  });

  test('a new version is announced and applied when the user says so', async ({
    app,
    page,
    context,
  }) => {
    await install(app);
    await app.toasts.getByRole('button', { name: app.t('toast.dismiss'), exact: true }).click();
    await app.addFixtures('aes-256-r6.pdf');
    await app.expectState('aes-256-r6.pdf', 'needs-password');

    // The site is updated (for this browser only: see static-server.mjs)…
    await context.addCookies([{ name: SW_VERSION_COOKIE, value: '2', url: SUBPATH_URL }]);
    await page.evaluate(async () => {
      await (await navigator.serviceWorker.ready).update();
    });
    // …and the app says so, without touching the work in progress.
    await app.expectToast('toast.update');
    await app.expectState('aes-256-r6.pdf', 'needs-password');
    expect(
      await page.evaluate(async () => {
        const registration = await navigator.serviceWorker.ready;
        return { waiting: registration.waiting !== null, active: registration.active?.state };
      }),
    ).toEqual({ waiting: true, active: 'activated' });

    // "Refresh": the new worker takes over and the page reloads under it.
    const reloaded = page.waitForEvent('load');
    await app.toasts
      .getByRole('button', { name: app.t('toast.update.action'), exact: true })
      .click();
    await reloaded;
    await app.ready();
    await controlled(app);
    const active = await page.evaluate(async () => {
      const registration = await navigator.serviceWorker.ready;
      const script = await (
        await fetch(registration.active!.scriptURL, { cache: 'reload' })
      ).text();
      return {
        waiting: registration.waiting !== null,
        version: /e2e: version (\w+)/.exec(script)?.[1],
      };
    });
    expect(active).toEqual({ waiting: false, version: '2' });
    await expect(app.toasts).not.toContainText(app.t('toast.update'));
    await expect(app.chooseButton).toBeVisible();
  });
});
