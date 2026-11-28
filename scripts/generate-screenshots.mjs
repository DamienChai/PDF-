// Renders the screenshots that the web manifest (vite.config.ts) and README.md refer to:
//
//   npm run screenshots                          builds the app, then runs this script
//   node scripts/generate-screenshots.mjs        uses the build that is in dist/
//     --out DIR      write somewhere else than public/screenshots/
//     --only NAME    one scene, e.g. --only phone-unlock
//     --scale N      device scale factor for every scene (1 gives small files to look at)
//
// What is photographed is the production build with the real engine, served from dist/ by a
// server that lives as long as this script, in the Chromium that Playwright installs anyway. The
// documents are fixtures of tests/fixtures under the names a person's files might have. Language
// (Simplified Chinese), theme (light), viewport and every input are fixed, and nothing that moves
// is on screen when a picture is taken, so a second run on the same machine produces the same
// files. Text is drawn with the fonts of that machine: tests/e2e/support/fonts.conf describes the
// setup that matches a Pixel phone (Roboto and Noto Sans SC).
//
// The labels of buttons and fields come from the app's own dictionary, a TypeScript file, which
// Node imports as it is from version 22.18.
//
// The results are committed; run this again when the interface changes. A full run ends by
// comparing the pictures with the `screenshots` of the built manifest, because Chrome leaves a
// screenshot out of its install dialog when the size in the manifest is not the size of the image.
import { createServer } from 'node:http';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { zhCN } from '../src/i18n/zh-CN.ts';

const root = fileURLToPath(new URL('..', import.meta.url));
const distDir = join(root, 'dist');
const fixtureDir = join(root, 'tests', 'fixtures');

/** A Pixel phone and a desktop window; `form` is the `form_factor` of the manifest. */
const PHONE = { width: 412, height: 915, scale: 2.625, mobile: true, form: 'narrow' };
const DESKTOP = { width: 1440, height: 900, scale: 1, mobile: false, form: 'wide' };

/** An install dialog downloads every picture of its form factor. */
const MAX_BYTES = 250 * 1024;

/** A message of the app, with its `{placeholders}` filled in. */
function t(key, params = {}) {
  return zhCN[key].replace(/\{(\w+)\}/g, (_, name) => String(params[name]));
}

// --- The documents ------------------------------------------------------------------------------

/** A fixture under the name it is shown with. */
function sample(name, fixture) {
  return { name, fixture };
}

// Protected files; all but the last open with `PASSWORD`.
const STATEMENT = sample('信用卡电子账单 2026-10.pdf', 'aes-256-r6.pdf');
const PAYSLIP = sample('工资单 2026-10.pdf', 'aes-128-r4.pdf');
const CHECKUP = sample('体检报告.pdf', 'pypdf-aes-256.pdf');
/** RC4, which the app calls outdated. */
const MANUAL = sample('设备说明书（2009）.pdf', 'rc4-128-r3.pdf');
const INSURANCE = sample('保险合同.pdf', 'same-password-r6.pdf');
/** Opens without a password; printing, copying and editing are restricted. */
const HANDBOOK = sample('产品手册（禁止打印）.pdf', 'owner-only-r6.pdf');
// Not encrypted.
const CONTRACT = sample('租房合同（扫描件）.pdf', 'plain.pdf');
const PASSPORT = sample('护照扫描件.pdf', 'objstm-plain.pdf');
const RESUME = sample('个人简历.pdf', 'linearized-plain.pdf');

const PASSWORD = 'user';
/** Shown as dots where a scene does not send it. */
const TYPED_PASSWORD = 'k7#Vq2mXw9';
const NEW_PASSWORD = 'Lantern-Quartz-58-Orbit';
const OWNER_PASSWORD = 'Harbor-Velvet-31-Summit';

// --- Driving the app ----------------------------------------------------------------------------

/** The app in one page, found the way a person finds things: by role and by name. */
class Stage {
  constructor(page) {
    this.page = page;
  }

  /** The action area. */
  get dock() {
    return this.page.getByRole('form');
  }

  card(file) {
    return this.page
      .locator('[data-entry]')
      .filter({ has: this.page.getByRole('heading', { name: file.name, exact: true }) });
  }

  /** Chooses files in the system file picker and waits until the app has read them. */
  async add(...files) {
    const chosen = await Promise.all(
      files.map(async ({ name, fixture }) => ({
        name,
        mimeType: 'application/pdf',
        buffer: await readFile(join(fixtureDir, fixture)),
      })),
    );
    const choose = this.page.getByRole('button', { name: t('empty.choose'), exact: true });
    const addMore = this.page.getByRole('button', { name: t('list.addMore'), exact: true });
    const chooser = this.page.waitForEvent('filechooser');
    await choose.or(addMore).first().click();
    await (await chooser).setFiles(chosen);
    for (const file of files) await this.card(file).waitFor();
    const analysing = this.page.locator('[data-entry][data-state="analysing"]');
    await analysing.first().waitFor({ state: 'detached' });
  }

  get unlockField() {
    return this.dock.getByPlaceholder(t('unlock.password.placeholder'), { exact: true });
  }

  /** Types the shared password and sends it with the Enter key. */
  async unlock(password) {
    await this.unlockField.fill(password);
    await this.unlockField.press('Enter');
  }

  async fillLockForm(password) {
    const field = (key) => this.dock.getByPlaceholder(t(key), { exact: true });
    await field('lock.password.placeholder').fill(password);
    await field('lock.confirm.placeholder').fill(password);
  }

  async lockMode() {
    const option = this.page.getByRole('radio', { name: t('mode.lock'), exact: true });
    await option.click();
    await option.and(this.page.locator('[aria-checked="true"]')).waitFor();
  }

  /** Waits until the cards of these files are in `state` (the `data-state` of a card). */
  async reached(state, ...files) {
    for (const file of files) {
      await this.card(file)
        .and(this.page.locator(`[data-state="${state}"]`))
        .waitFor();
    }
  }
}

// --- The scenes ---------------------------------------------------------------------------------

/** One protected file, its password typed and not yet sent. */
async function phoneUnlock(stage) {
  await stage.add(STATEMENT);
  await stage.unlockField.fill(TYPED_PASSWORD);
}

/** The same file, unlocked: save, share, or start over. */
async function phoneDone(stage) {
  await stage.add(STATEMENT);
  await stage.unlock(PASSWORD);
  await stage.reached('done', STATEMENT);
}

async function phoneLock(stage) {
  await stage.lockMode();
  await stage.add(CONTRACT);
  await stage.fillLockForm(NEW_PASSWORD);
}

/** Several files with one password, before they are unlocked: what each of them needs. */
async function phoneBatch(stage) {
  await stage.add(STATEMENT, PAYSLIP, MANUAL, HANDBOOK);
  await stage.unlockField.fill(TYPED_PASSWORD);
}

async function desktopUnlock(stage) {
  await stage.add(STATEMENT, PAYSLIP, CHECKUP);
  await stage.unlockField.fill(TYPED_PASSWORD);
}

async function desktopDone(stage) {
  await stage.add(STATEMENT, PAYSLIP, CHECKUP);
  await stage.unlock(PASSWORD);
  await stage.reached('done', STATEMENT, PAYSLIP, CHECKUP);
}

async function desktopLock(stage) {
  await stage.lockMode();
  await stage.add(CONTRACT, PASSPORT, RESUME);
  await stage.fillLockForm(NEW_PASSWORD);
  await stage.dock.getByRole('button', { name: new RegExp(`^${t('lock.advanced')}`) }).click();
  await stage.dock.getByRole('switch', { name: t('lock.owner.switch'), exact: true }).click();
  await stage.dock
    .getByPlaceholder(t('lock.owner.placeholder'), { exact: true })
    .fill(OWNER_PASSWORD);
  await stage.dock.getByRole('radio', { name: t('lock.print.low'), exact: true }).click();
  await stage.dock.getByRole('switch', { name: t('lock.permission.modify'), exact: true }).click();
}

/** A mixed list after one password: unlocked, freed of restrictions, nothing to do, rejected. */
async function desktopBatch(stage) {
  await stage.add(STATEMENT, PAYSLIP, CHECKUP, HANDBOOK, CONTRACT, INSURANCE);
  await stage.unlock(PASSWORD);
  await stage.reached('done', STATEMENT, PAYSLIP, CHECKUP, HANDBOOK);
  await stage.reached('wrong-password', INSURANCE);
  await stage.unlockField.fill(TYPED_PASSWORD);
}

/** File name, device and what is on screen. */
const SCENES = [
  { name: 'phone-unlock', device: PHONE, play: phoneUnlock },
  { name: 'phone-done', device: PHONE, play: phoneDone },
  { name: 'phone-lock', device: PHONE, play: phoneLock },
  { name: 'phone-batch', device: PHONE, play: phoneBatch },
  { name: 'desktop-unlock', device: DESKTOP, play: desktopUnlock },
  { name: 'desktop-done', device: DESKTOP, play: desktopDone },
  { name: 'desktop-lock', device: DESKTOP, play: desktopLock },
  { name: 'desktop-batch', device: DESKTOP, play: desktopBatch },
];

// --- Serving dist/ ------------------------------------------------------------------------------

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.wasm': 'application/wasm',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.webmanifest': 'application/manifest+json',
  '.txt': 'text/plain; charset=utf-8',
};

/** A static server for dist/ on a free local port. */
async function serve() {
  const server = createServer(async (request, response) => {
    const { pathname } = new URL(request.url ?? '/', 'http://localhost');
    let relative = normalize(decodeURIComponent(pathname)).replace(/^[/\\]+/, '');
    if (relative === '' || relative.endsWith('/')) relative += 'index.html';
    const file = resolve(distDir, relative);
    try {
      if (!file.startsWith(distDir + sep)) throw new Error('outside of dist/');
      const body = await readFile(file);
      response.writeHead(200, {
        'Content-Type': TYPES[extname(file)] ?? 'application/octet-stream',
      });
      response.end(body);
    } catch {
      response.writeHead(404).end('Not Found');
    }
  });
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  return { url: `http://127.0.0.1:${server.address().port}/`, close: () => server.close() };
}

// --- Taking the pictures ------------------------------------------------------------------------

function parseArguments(argv) {
  const options = { out: join(root, 'public', 'screenshots'), only: null, scale: null };
  for (let i = 0; i < argv.length; i++) {
    const value = argv[i + 1];
    if (argv[i] === '--out' && value) options.out = resolve(argv[++i]);
    else if (argv[i] === '--only' && value) options.only = argv[++i];
    else if (argv[i] === '--scale' && Number(value) > 0) options.scale = Number(argv[++i]);
    else throw new Error(`unknown or incomplete argument: ${argv[i]}`);
  }
  return options;
}

/**
 * Chrome on Android can hand PDF files to the system share sheet; the Chromium that takes the
 * pictures cannot, and the app would leave its share buttons out. Runs in the page.
 */
function emulateShareSheet() {
  const canShare = (data) => (data?.files ?? []).every((file) => file.type === 'application/pdf');
  Object.defineProperty(navigator, 'canShare', { configurable: true, value: canShare });
  Object.defineProperty(navigator, 'share', { configurable: true, value: async () => {} });
}

/**
 * Waits until the page has stopped changing: fonts are loaded, and every transition and animation
 * has ended and has been painted in its final state. Runs in the page.
 */
async function settle() {
  const frames = async (count) => {
    for (let i = 0; i < count; i++) await new Promise((resolve) => requestAnimationFrame(resolve));
  };
  const running = () =>
    document.getAnimations().filter((animation) => animation.playState === 'running');
  await document.fonts.ready;
  do {
    await frames(2);
    await Promise.all(running().map((animation) => animation.finished.catch(() => undefined)));
  } while (running().length > 0);
  await frames(2);
}

/** Width and height of a PNG as the manifest writes them, from its header. */
function pngSize(png) {
  return `${png.readUInt32BE(16)}x${png.readUInt32BE(20)}`;
}

/** What is wrong between the pictures just taken and the manifest of the build. */
async function manifestMismatches(taken) {
  const manifest = JSON.parse(await readFile(join(distDir, 'manifest.webmanifest'), 'utf8'));
  const listed = new Map((manifest.screenshots ?? []).map((entry) => [entry.src, entry]));
  const mismatches = [];
  for (const { scene, size } of taken) {
    const src = `screenshots/${scene.name}.png`;
    const entry = listed.get(src);
    listed.delete(src);
    if (!entry) {
      mismatches.push(`${src} is not listed`);
      continue;
    }
    if (entry.sizes !== size) mismatches.push(`${src} is ${size}, listed as ${entry.sizes}`);
    if (entry.form_factor !== scene.device.form) {
      mismatches.push(`${src} is ${scene.device.form}, listed as ${entry.form_factor}`);
    }
  }
  for (const src of listed.keys()) mismatches.push(`${src} is listed, but no scene produces it`);
  return mismatches;
}

async function shoot(browser, baseUrl, scene, scale) {
  const { device } = scene;
  const context = await browser.newContext({
    viewport: { width: device.width, height: device.height },
    deviceScaleFactor: scale ?? device.scale,
    isMobile: device.mobile,
    hasTouch: device.mobile,
    locale: 'zh-CN',
    colorScheme: 'light',
    reducedMotion: 'reduce',
    // The first visit would announce "ready to work offline" on top of the scene.
    serviceWorkers: 'block',
  });
  try {
    const problems = [];
    context.on('weberror', (error) => problems.push(error.error().message));
    if (device.mobile) await context.addInitScript(emulateShareSheet);
    const page = await context.newPage();
    page.on('console', (message) => {
      if (message.type() === 'error' && !message.text().includes('Service Worker registration')) {
        problems.push(message.text());
      }
    });
    await page.goto(baseUrl);
    await page.getByRole('heading', { level: 1, name: t('app.name') }).waitFor();
    await scene.play(new Stage(page));
    // The pointer rests on nothing, and nothing shows a focus ring.
    await page.mouse.move(0, 0);
    await page.evaluate(() => {
      if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
    });
    await page.evaluate(settle);
    const png = await page.screenshot({ type: 'png', animations: 'disabled', caret: 'hide' });
    if (problems.length > 0) throw new Error(`${scene.name}: ${problems.join('; ')}`);
    return png;
  } finally {
    await context.close();
  }
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  await stat(join(distDir, 'index.html')).catch(() => {
    throw new Error('dist/ is missing: run "npm run build" first, or "npm run screenshots".');
  });
  const scenes = SCENES.filter((scene) => !options.only || scene.name === options.only);
  if (scenes.length === 0) throw new Error(`no scene is called ${options.only}`);

  await mkdir(options.out, { recursive: true });
  const server = await serve();
  // Chromium repaints only what changed, and where such a patch ends its edges are blended a
  // shade differently. What changed when depends on timing; repainting whole tiles does not.
  const browser = await chromium.launch({ args: ['--disable-partial-raster'] });
  const taken = [];
  try {
    for (const scene of scenes) {
      const png = await shoot(browser, server.url, scene, options.scale);
      const size = pngSize(png);
      await writeFile(join(options.out, `${scene.name}.png`), png);
      console.log(`${scene.name}.png  ${size}  ${(png.length / 1024).toFixed(1)} KiB`);
      taken.push({ scene, size, bytes: png.length });
    }
  } finally {
    await browser.close();
    server.close();
  }

  const problems = taken
    .filter(({ bytes }) => bytes > MAX_BYTES)
    .map(({ scene }) => `${scene.name}.png is larger than ${MAX_BYTES / 1024} KiB`);
  // Only a full run at the real sizes can be compared with the manifest.
  if (!options.only && !options.scale) {
    const mismatches = await manifestMismatches(taken);
    problems.push(...mismatches.map((mismatch) => `manifest of dist/: ${mismatch}`));
  }
  if (problems.length > 0) {
    throw new Error(`${problems.join('\n')}\nSee \`screenshots\` in vite.config.ts.`);
  }
}

await main();
