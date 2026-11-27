/**
 * The test fixture of the end-to-end suite and a small page object for the app.
 *
 *   import { expect, test } from './support/app';
 *
 *   test('…', async ({ app }) => {
 *     await app.open();
 *     await app.addFixtures('aes-256-r6.pdf');
 *     …
 *   });
 *
 * Elements are found the way a person (or a screen reader) finds them: by role and name. The
 * names come from the app's own dictionaries, so the same test reads the Chinese phone project
 * and the English desktop project.
 *
 * Every test fails if the app logged an error or a warning, threw, violated its
 * Content-Security-Policy, had a request fail, or talked to another origin (see `issues`).
 */
import { readFile } from 'node:fs/promises';
import {
  test as base,
  expect,
  type BrowserContext,
  type Locator,
  type Page,
} from '@playwright/test';
import { translate, type MessageKey } from '../../../src/i18n/translate';
import type { MessageParams } from '../../../src/i18n/types';
import { fixturePath } from './files';

export { expect };

export type Lang = 'zh-CN' | 'en';

/** What `data-state` of a file card says, and the chip that says the same in words. */
const STATE_CHIPS = {
  analysing: 'chip.analysing',
  'needs-password': 'chip.needsPassword',
  restricted: 'chip.restricted',
  'not-encrypted': 'chip.notEncrypted',
  ready: 'chip.notEncrypted',
  encrypted: 'chip.encrypted',
  'wrong-password': 'chip.wrongPassword',
  error: 'chip.error',
} as const satisfies Record<string, MessageKey>;

export type CardState = keyof typeof STATE_CHIPS | 'done' | 'processing';

/**
 * The action area ignores a press that follows, within half a second, a press on a button that
 * did something else (double-tap guard, src/ui/dock-parts.tsx). A person is never that fast; the
 * tests are, so `press()` keeps this distance between two presses in the action area.
 */
const DOUBLE_TAP_GUARD_MS = 550;

export interface SavedFile {
  /** The file name the browser was given. */
  name: string;
  path: string;
  bytes: Buffer;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export class App {
  private lastPress = 0;
  private downloads = 0;

  constructor(
    readonly page: Page,
    /** The language the app is showing. Change it when a test switches the language. */
    public lang: Lang,
    /** The phone layout: sticky action area, bottom sheets, one file fills the stage. */
    readonly phone: boolean,
    private readonly outputPath: (...segments: string[]) => string,
  ) {}

  /** A message of the app in the current language. */
  t(key: MessageKey, params?: MessageParams): string {
    return translate(this.lang, key, params);
  }

  /** A message in either language: for elements whose language a test does not care about. */
  private either(key: MessageKey, params?: MessageParams): RegExp {
    const texts = [translate('zh-CN', key, params), translate('en', key, params)];
    return new RegExp(`^(?:${texts.map(escapeRegExp).join('|')})$`);
  }

  // --- Navigation --------------------------------------------------------------------------------

  async open(url = './'): Promise<void> {
    await this.page.goto(url);
    await this.ready();
  }

  async ready(): Promise<void> {
    await expect(this.page.getByRole('heading', { level: 1 })).toHaveText(this.t('app.name'));
    // Components attach their window-level listeners (keyboard shortcuts) right after the first
    // paint. A person cannot press a key before that; a test can. One frame and a task later
    // the app is as ready as it looks.
    await this.page.evaluate(
      () =>
        new Promise<void>((resolve) => {
          requestAnimationFrame(() => setTimeout(() => setTimeout(resolve)));
        }),
    );
  }

  /**
   * Waits until everything that is moving into place has arrived (spinners, which never end,
   * aside). A sheet slides in and a dialog grows in for a third of a second; a press aimed at a
   * small control inside it during that time can come down beside it.
   */
  async settled(): Promise<void> {
    await this.page.evaluate(async () => {
      const ends = (animation: Animation): boolean =>
        animation.effect?.getComputedTiming().iterations !== Infinity;
      await Promise.all(
        document
          .getAnimations()
          .filter(ends)
          .map((animation) => animation.finished.catch(() => undefined)),
      );
    });
  }

  // --- Top bar -----------------------------------------------------------------------------------

  modeOption(mode: 'unlock' | 'lock'): Locator {
    return this.page.getByRole('radiogroup', { name: this.t('mode.label') }).getByRole('radio', {
      name: this.t(mode === 'unlock' ? 'mode.unlock' : 'mode.lock'),
      exact: true,
    });
  }

  async switchMode(mode: 'unlock' | 'lock'): Promise<void> {
    await this.modeOption(mode).click();
    await expect(this.modeOption(mode)).toBeChecked();
  }

  get settingsButton(): Locator {
    return this.page.getByRole('button', { name: this.t('topbar.settings'), exact: true });
  }

  get settings(): Locator {
    return this.page.getByRole('dialog', { name: this.t('settings.title'), exact: true });
  }

  async openSettings(): Promise<Locator> {
    await this.settingsButton.click();
    await expect(this.settings).toBeVisible();
    await this.settled();
    return this.settings;
  }

  /** The dialog or sheet that is open, whatever it is. */
  get dialog(): Locator {
    return this.page.getByRole('dialog');
  }

  get closeButton(): Locator {
    return this.dialog.getByRole('button', { name: this.t('aria.close'), exact: true });
  }

  // --- Getting files in --------------------------------------------------------------------------

  /** "Choose PDFs" of the empty state. */
  get chooseButton(): Locator {
    return this.page.getByRole('button', { name: this.t('empty.choose'), exact: true });
  }

  /** "Add files" in the header of the list. */
  get addButton(): Locator {
    return this.page.getByRole('button', { name: this.t('list.addMore'), exact: true });
  }

  /** Chooses files in the system file picker that `trigger` opens. */
  async choose(trigger: Locator, paths: readonly string[]): Promise<void> {
    const chooser = this.page.waitForEvent('filechooser');
    await trigger.click();
    await (await chooser).setFiles([...paths]);
  }

  /** Adds files of tests/fixtures through the file picker, with whichever button is there. */
  async addFixtures(...names: string[]): Promise<void> {
    await this.addFiles(names.map(fixturePath));
  }

  async addFiles(paths: readonly string[]): Promise<void> {
    await this.choose(this.chooseButton.or(this.addButton).first(), paths);
  }

  // --- The list ----------------------------------------------------------------------------------

  get cards(): Locator {
    return this.page.locator('[data-entry]');
  }

  /** The card (in the list) or the stage (one file on the phone) of a file. */
  card(name: string): Locator {
    return this.cards.filter({ has: this.page.getByRole('heading', { name, exact: true }) });
  }

  /** Asserts the state of a file: the machine-readable one and the chip a person reads. */
  async expectState(name: string, state: CardState, mode: 'unlock' | 'lock' = 'unlock') {
    const card = this.card(name);
    await expect(card).toHaveAttribute('data-state', state);
    if (state === 'processing') return;
    const chip =
      state === 'done' ? (mode === 'unlock' ? 'chip.unlocked' : 'chip.locked') : STATE_CHIPS[state];
    await expect(card).toContainText(this.t(chip));
  }

  /** Waits until no file is being read any more. */
  async analysed(count: number): Promise<void> {
    await expect(this.cards).toHaveCount(count);
    await expect(this.page.locator('[data-entry][data-state="analysing"]')).toHaveCount(0);
  }

  menuButton(name: string): Locator {
    return this.page.getByRole('button', { name: this.t('aria.fileMenu', { name }), exact: true });
  }

  menuItem(key: MessageKey): Locator {
    return this.page.getByRole('menuitem', { name: this.t(key), exact: true });
  }

  /**
   * Chooses a command from the menu of a file and waits until the menu is gone: on the phone it
   * is a sheet, and the page behind it is out of reach until it has slid away.
   */
  async menuCommand(name: string, key: MessageKey): Promise<void> {
    await this.openMenu(name);
    await this.menuItem(key).click();
    await expect(this.page.getByRole('menu')).toHaveCount(0);
    await expect(this.dialog).toHaveCount(0);
  }

  /** Opens the menu of a file: a sheet on the phone, a popover on desktop. */
  async openMenu(name: string): Promise<Locator> {
    await this.menuButton(name).click();
    const menu = this.page.getByRole('menu');
    await expect(menu).toBeVisible();
    await this.settled();
    return menu;
  }

  /** Opens the details of a file through its menu and returns the dialog. */
  async openDetails(name: string): Promise<Locator> {
    await this.openMenu(name);
    await this.menuItem('entry.menu.details').click();
    // On the phone the menu is a sheet of the same name, still sliding away for a moment.
    const details = this.page
      .getByRole('dialog', { name, exact: true })
      .filter({ hasText: this.t('details.title') });
    await expect(details).toBeVisible();
    await expect(this.dialog).toHaveCount(1);
    await this.settled();
    return details;
  }

  async closeDialog(): Promise<void> {
    await this.closeButton.click();
    await expect(this.dialog).toHaveCount(0);
  }

  /** The inline password field of a card (retry in Unlock mode, current password in Lock mode). */
  cardField(name: string): Locator {
    const retry = this.t('entry.password.label');
    const current = this.t('entry.currentPassword.label');
    return this.card(name).getByLabel(
      new RegExp(`^(?:${escapeRegExp(retry)}|${escapeRegExp(current)}): `),
    );
  }

  // --- The action area ---------------------------------------------------------------------------

  /** The action area: a form named after what it does. */
  get dock(): Locator {
    const names = [this.t('dock.unlock.title'), this.t('dock.lock.headline')];
    return this.page.getByRole('form', {
      name: new RegExp(`^(?:${names.map(escapeRegExp).join('|')})$`),
    });
  }

  dockButton(key: MessageKey, params?: MessageParams): Locator {
    return this.dock.getByRole('button', { name: this.t(key, params), exact: true });
  }

  /** The shared password field of Unlock mode. */
  get unlockField(): Locator {
    return this.dock.getByPlaceholder(this.t('unlock.password.placeholder'), { exact: true });
  }

  /** Presses a button of the action area, never faster than a person could (see above). */
  async press(button: Locator): Promise<void> {
    const wait = this.lastPress + DOUBLE_TAP_GUARD_MS - Date.now();
    if (wait > 0) await this.page.waitForTimeout(wait);
    await button.click();
    this.lastPress = Date.now();
  }

  /** Types the shared password and submits it with the keyboard's Go / Enter key. */
  async unlockWith(password: string): Promise<void> {
    await this.unlockField.fill(password);
    await this.unlockField.press('Enter');
  }

  // --- Lock form ---------------------------------------------------------------------------------

  get lockPassword(): Locator {
    return this.dock.getByPlaceholder(this.t('lock.password.placeholder'), { exact: true });
  }

  get lockConfirmation(): Locator {
    return this.dock.getByPlaceholder(this.t('lock.confirm.placeholder'), { exact: true });
  }

  get ownerPassword(): Locator {
    return this.dock.getByPlaceholder(this.t('lock.owner.placeholder'), { exact: true });
  }

  get advancedToggle(): Locator {
    return this.dock.getByRole('button', { name: new RegExp(`^${this.t('lock.advanced')}`) });
  }

  async openAdvanced(): Promise<void> {
    if ((await this.advancedToggle.getAttribute('aria-expanded')) !== 'true') {
      await this.advancedToggle.click();
    }
    await expect(this.advancedToggle).toHaveAttribute('aria-expanded', 'true');
  }

  switch(key: MessageKey, within: Locator = this.page.locator('body')): Locator {
    return within.getByRole('switch', { name: this.t(key), exact: true });
  }

  // --- Feedback ----------------------------------------------------------------------------------

  get toasts(): Locator {
    return this.page.getByRole('region', { name: this.either('aria.notifications') });
  }

  async expectToast(key: MessageKey, params?: MessageParams): Promise<void> {
    await expect(this.toasts).toContainText(this.t(key, params));
  }

  // --- Results -----------------------------------------------------------------------------------

  /** Runs `action`, which must start a download, and returns the downloaded file. */
  async download(action: () => Promise<void>): Promise<SavedFile> {
    const pending = this.page.waitForEvent('download');
    await action();
    const download = await pending;
    const name = download.suggestedFilename();
    const path = this.outputPath('downloads', `${++this.downloads}`, name);
    await download.saveAs(path);
    return { name, path, bytes: await readFile(path) };
  }

  /** Saves the only result (or the ZIP of all results) with the primary button. */
  async saveAll(): Promise<SavedFile> {
    const single = this.dockButton('entry.save');
    const several = this.dockButton('action.saveAll');
    return this.download(() => this.press(single.or(several)));
  }

  /** "Clear" in the header of the list: back to the empty state. */
  async clear(): Promise<void> {
    await this.page.getByRole('button', { name: this.t('action.clear'), exact: true }).click();
    await expect(this.chooseButton).toBeVisible();
  }

  /** "Process new files": back to the empty state. */
  async startOver(): Promise<void> {
    await this.press(this.dockButton('action.startOver'));
    await expect(this.chooseButton).toBeVisible();
  }
}

// --- Issues: what must never happen in any test ---------------------------------------------------

export interface Issues {
  /** Everything unexpected that happened so far. */
  readonly found: readonly string[];
  /** Declares issues matching `pattern` as expected in this test (say why in a comment). */
  allow(pattern: RegExp): void;
}

const PLAYWRIGHT_SERVICE_WORKER_NOTE = 'Service Worker registration blocked by Playwright';

/** Bindings cannot be exposed twice; one name per context. */
const CSP_BINDING = '__pdfkeyE2eCspViolation';

async function watch(context: BrowserContext, origin: string): Promise<string[]> {
  const found: string[] = [];

  context.on('console', (message) => {
    const type = message.type();
    if (type !== 'error' && type !== 'warning') return;
    // Playwright's own note where a test runs without service workers (`serviceWorkers: 'block'`).
    if (message.text() === PLAYWRIGHT_SERVICE_WORKER_NOTE) return;
    const { url, lineNumber } = message.location();
    found.push(`console.${type}: ${message.text()}${url ? ` (${url}:${lineNumber})` : ''}`);
  });
  context.on('weberror', (webError) => {
    found.push(`uncaught error: ${webError.error().stack ?? webError.error().message}`);
  });
  context.on('requestfailed', (request) => {
    found.push(
      `request failed: ${request.method()} ${request.url()} (${request.failure()?.errorText ?? 'unknown'})`,
    );
  });
  context.on('request', (request) => {
    const url = request.url();
    if (url.startsWith('blob:') || url.startsWith('data:')) return;
    if (!url.startsWith(`${origin}/`)) {
      found.push(`request to another origin: ${request.method()} ${url}`);
    }
  });
  context.on('response', (response) => {
    if (response.status() >= 400) {
      found.push(`HTTP ${response.status()}: ${response.request().method()} ${response.url()}`);
    }
  });
  context.on('serviceworker', (worker) => {
    worker.on('console', (message) => {
      const type = message.type();
      if (type === 'error' || type === 'warning') {
        found.push(`service worker console.${type}: ${message.text()}`);
      }
    });
  });

  await context.exposeBinding(CSP_BINDING, (_source, violation: string) => {
    found.push(`CSP violation: ${violation}`);
  });
  await context.addInitScript((binding) => {
    document.addEventListener('securitypolicyviolation', (event) => {
      const report = (window as unknown as Record<string, (text: string) => void>)[binding];
      report?.(`${event.violatedDirective} blocked ${event.blockedURI || 'inline'}`);
    });
  }, CSP_BINDING);

  return found;
}

// --- Fixtures ----------------------------------------------------------------------------------

export interface Options {
  /**
   * `none` (default): the browser has no "save as" and folder pickers, like Chrome on Android,
   * Firefox and Safari; results are downloaded. `opfs`: `showSaveFilePicker` and
   * `showDirectoryPicker` exist (desktop Chrome and Edge) and "choose" a file or folder in the
   * origin-private file system, because nothing can drive the real system dialogs.
   */
  filePickers: 'none' | 'opfs';
}

export interface Fixtures {
  app: App;
  issues: Issues;
}

export const test = base.extend<Options & Fixtures>({
  filePickers: ['none', { option: true }],

  issues: [
    async ({ context, baseURL, filePickers }, use) => {
      const origin = new URL(baseURL ?? 'http://127.0.0.1').origin;
      const found = await watch(context, origin);
      const allowed: RegExp[] = [];

      await context.addInitScript((pickers) => {
        const scope = window as unknown as Record<string, unknown>;
        if (pickers === 'none') {
          delete scope.showSaveFilePicker;
          delete scope.showDirectoryPicker;
          return;
        }
        scope.showSaveFilePicker = async (options?: { suggestedName?: string }) => {
          const root = await navigator.storage.getDirectory();
          return root.getFileHandle(options?.suggestedName ?? 'untitled', { create: true });
        };
        scope.showDirectoryPicker = () => navigator.storage.getDirectory();
      }, filePickers);

      await use({
        found,
        allow: (pattern) => void allowed.push(pattern),
      });

      const unexpected = found.filter((issue) => !allowed.some((pattern) => pattern.test(issue)));
      expect(
        unexpected,
        'console errors and warnings, uncaught errors, CSP violations, failed requests and requests to other origins',
      ).toEqual([]);
    },
    { auto: true },
  ],

  app: async ({ page, locale, isMobile }, use, testInfo) => {
    // Keeps the interception of file pickers switched on for the whole test. Playwright switches
    // it on with the first listener, and a picker opened by a key press right after
    // `waitForEvent('filechooser')` can be faster than that.
    page.on('filechooser', () => undefined);
    const lang: Lang = (locale ?? 'en').toLowerCase().startsWith('zh') ? 'zh-CN' : 'en';
    await use(
      new App(page, lang, isMobile === true, (...segments) => testInfo.outputPath(...segments)),
    );
  },
});
