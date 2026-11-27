/**
 * Settings: language, theme, output names, automatic saving and the two output options. Each
 * setting is checked by what it changes, not by the control's own state alone.
 */
import type { Locator } from '@playwright/test';
import { expect, test, type App, type Lang } from './support/app';
import { fixture, unlockedName } from './support/files';
import { expectUnlockedCopy, inspectPdf, rawFacts } from './support/pdf';
import { readZip } from './support/zip';

function group(app: App, settings: Locator, label: Parameters<App['t']>[0]): Locator {
  return settings.getByRole('radiogroup', { name: app.t(label), exact: true });
}

async function unlockAndSave(app: App, file: string, password: string) {
  await app.addFixtures(file);
  await app.expectState(file, 'needs-password');
  await app.unlockWith(password);
  await app.expectState(file, 'done');
  return app.saveAll();
}

test.describe('settings', () => {
  test('the language changes at once and is remembered', async ({ app, page }) => {
    const system: Lang = app.lang;
    const other: Lang = system === 'en' ? 'zh-CN' : 'en';
    const nameOf = { 'zh-CN': '简体中文', en: 'English' } as const;

    await app.open();
    await expect(page.locator('html')).toHaveAttribute('lang', system);
    let settings = await app.openSettings();
    const follow = app.t('settings.language.auto');
    await expect(
      group(app, settings, 'settings.language').getByRole('radio', { name: follow }),
    ).toBeChecked();

    // Switch: everything on screen follows, without a reload.
    await group(app, settings, 'settings.language')
      .getByRole('radio', { name: nameOf[other], exact: true })
      .click();
    app.lang = other;
    await expect(app.settings).toBeVisible();
    await expect(page.locator('html')).toHaveAttribute('lang', other);
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(app.t('app.name'));
    await expect(app.settings).toContainText(app.t('settings.theme'));
    await expect(app.settings).toContainText(app.t('about.privacy'));
    await app.closeDialog();
    await expect(app.chooseButton).toBeVisible();
    await expect(app.modeOption('lock')).toBeVisible();

    // Remembered: the reloaded app starts in that language, before the first paint.
    await page.reload();
    await app.ready();
    await expect(page.locator('html')).toHaveAttribute('lang', other);
    await expect(app.chooseButton).toBeVisible();

    // The names of the languages are never translated, so the way back is always readable.
    settings = await app.openSettings();
    await expect(
      group(app, settings, 'settings.language').getByRole('radio', {
        name: nameOf[other],
        exact: true,
      }),
    ).toBeChecked();
    await group(app, settings, 'settings.language')
      .getByRole('radio', { name: nameOf[system], exact: true })
      .click();
    app.lang = system;
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(app.t('app.name'));

    // "Follow the system" goes back to the browser's language.
    await group(app, app.settings, 'settings.language')
      .getByRole('radio', { name: app.t('settings.language.auto'), exact: true })
      .click();
    await expect(page.locator('html')).toHaveAttribute('lang', system);
  });

  test('the theme sets data-theme and the browser colour, and is remembered', async ({
    app,
    page,
  }) => {
    const themeColors = () =>
      page
        .locator('meta[name="theme-color"]')
        .evaluateAll((metas) => metas.map((meta) => meta.getAttribute('content')));
    const background = () => page.evaluate(() => getComputedStyle(document.body).backgroundColor);
    const html = page.locator('html');

    await page.emulateMedia({ colorScheme: 'light' });
    await app.open();
    await expect(html).toHaveAttribute('data-theme', 'light');
    // Following the system: one colour per colour scheme.
    expect(await themeColors()).toEqual(['#F7F7FB', '#111318']);
    const lightBackground = await background();

    const settings = await app.openSettings();
    const theme = group(app, settings, 'settings.theme');
    await theme.getByRole('radio', { name: app.t('settings.theme.dark'), exact: true }).click();
    await expect(html).toHaveAttribute('data-theme', 'dark');
    expect(await themeColors()).toEqual(['#111318', '#111318']);
    expect(await background()).not.toBe(lightBackground);

    // Remembered, and applied before the app's script runs.
    await page.reload();
    await expect(html).toHaveAttribute('data-theme', 'dark');
    await app.ready();
    expect(await themeColors()).toEqual(['#111318', '#111318']);

    await app.openSettings();
    await group(app, app.settings, 'settings.theme')
      .getByRole('radio', { name: app.t('settings.theme.light'), exact: true })
      .click();
    await expect(html).toHaveAttribute('data-theme', 'light');
    expect(await themeColors()).toEqual(['#F7F7FB', '#F7F7FB']);
    expect(await background()).toBe(lightBackground);

    // "System" follows the device, live.
    await group(app, app.settings, 'settings.theme')
      .getByRole('radio', { name: app.t('settings.theme.system'), exact: true })
      .click();
    await expect(html).toHaveAttribute('data-theme', 'light');
    await page.emulateMedia({ colorScheme: 'dark' });
    await expect(html).toHaveAttribute('data-theme', 'dark');
    expect(await themeColors()).toEqual(['#F7F7FB', '#111318']);
  });

  test('the suffix for unlocked files changes the output name', async ({ app }) => {
    const source = fixture('aes-256-r6.pdf');
    await app.open();
    const settings = await app.openSettings();
    const suffix = settings.getByLabel(app.t('settings.naming.decryptSuffix'), { exact: true });
    await expect(suffix).toHaveValue('_unlocked');

    // Characters no file name can have are dropped; the preview shows the result.
    await suffix.fill('-open/:*');
    await suffix.blur();
    await expect(suffix).toHaveValue('-open');
    const sample = app.t('settings.naming.sample').replace('.pdf', '-open.pdf');
    await expect(settings).toContainText(app.t('settings.naming.preview', { name: sample }));
    await app.closeDialog();

    const saved = await unlockAndSave(app, source.file, source.userPassword!);
    expect(saved.name).toBe('aes-256-r6-open.pdf');
    await expectUnlockedCopy(saved.bytes, source);

    // "Reset" brings the default names back.
    await app.openSettings();
    const reset = app.settings.getByRole('button', {
      name: app.t('settings.naming.reset'),
      exact: true,
    });
    await expect(reset).toBeEnabled();
    await reset.click();
    // Nothing left to reset…
    await expect(reset).toBeDisabled();
    // …and the field and the example show the default again.
    await expect(
      app.settings.getByLabel(app.t('settings.naming.decryptSuffix'), { exact: true }),
    ).toHaveValue('_unlocked');
    await expect(app.settings).toContainText(
      app.t('settings.naming.preview', {
        name: app.t('settings.naming.sample').replace('.pdf', '_unlocked.pdf'),
      }),
    );
  });

  test('the suffix for locked files changes the output name', async ({ app }) => {
    await app.open();
    const settings = await app.openSettings();
    await settings
      .getByLabel(app.t('settings.naming.encryptSuffix'), { exact: true })
      .fill('.protected');
    await app.closeDialog();

    await app.switchMode('lock');
    await app.addFixtures('plain.pdf');
    await app.expectState('plain.pdf', 'ready', 'lock');
    await app.lockPassword.fill('suffix-test-password');
    await app.lockConfirmation.fill('suffix-test-password');
    await app.lockConfirmation.press('Enter');
    await app.expectState('plain.pdf', 'done', 'lock');
    expect((await app.saveAll()).name).toBe('plain.protected.pdf');
  });

  test('automatic saving downloads a single result as soon as it is ready', async ({ app }) => {
    const source = fixture('aes-256-r6.pdf');
    await app.open();
    const settings = await app.openSettings();
    const autoSave = app.switch('settings.autoSave', settings);
    await expect(autoSave).not.toBeChecked();
    await autoSave.click();
    await expect(autoSave).toBeChecked();
    await app.closeDialog();

    await app.addFixtures(source.file);
    await app.expectState(source.file, 'needs-password');
    const saved = await app.download(() => app.unlockWith(source.userPassword!));
    expect(saved.name).toBe(unlockedName(source.file));
    await expectUnlockedCopy(saved.bytes, source);
    await app.expectToast('toast.autoSaved');
    await expect(app.card(source.file)).toContainText(app.t('entry.saved'));
    await expect(app.dock).toContainText(app.t('dock.saved'));
  });

  test('automatic saving bundles several results into one ZIP', async ({ app }) => {
    const sources = [fixture('aes-256-r6.pdf'), fixture('rc4-128-r3.pdf')];
    await app.open();
    await app.switch('settings.autoSave', await app.openSettings()).click();
    await app.closeDialog();

    await app.addFixtures(...sources.map((source) => source.file));
    await app.analysed(2);
    const archive = await app.download(() => app.unlockWith('user'));
    expect(archive.name).toBe(`${app.t('zip.unlocked')}.zip`);
    const entries = readZip(archive.bytes);
    expect(entries.map((entry) => entry.name)).toEqual(
      sources.map((source) => unlockedName(source.file)),
    );
    await expectUnlockedCopy(entries[0]!.data, sources[0]!);
    await expectUnlockedCopy(entries[1]!.data, sources[1]!);
  });

  test('"optimise file size" packs the output and keeps it valid', async ({ app }) => {
    const source = fixture('aes-256-r6.pdf');
    await app.open();

    const plain = await unlockAndSave(app, source.file, source.userPassword!);
    expect(rawFacts(plain.bytes).objectStreams).toBe(false);
    await app.startOver();

    const settings = await app.openSettings();
    await app.switch('settings.output.optimize', settings).click();
    await expect(app.switch('settings.output.optimize', settings)).toBeChecked();
    await app.closeDialog();

    const optimized = await unlockAndSave(app, source.file, source.userPassword!);
    await expectUnlockedCopy(optimized.bytes, source);
    expect(rawFacts(optimized.bytes).objectStreams).toBe(true);
    expect(optimized.bytes.length).toBeLessThan(plain.bytes.length);
  });

  test('"fast web view" linearizes the output and keeps it valid', async ({ app }) => {
    const source = fixture('aes-256-r6.pdf');
    await app.open();
    const settings = await app.openSettings();
    await app.switch('settings.output.linearize', settings).click();
    await app.closeDialog();

    const saved = await unlockAndSave(app, source.file, source.userPassword!);
    await expectUnlockedCopy(saved.bytes, source);
    expect(rawFacts(saved.bytes).linearized).toBe(true);
    expect((await inspectPdf(saved.bytes)).linearized).toBe(true);

    // The app's own details agree.
    await app.startOver();
    await app.addFiles([saved.path]);
    await app.expectState(saved.name, 'not-encrypted');
    const details = await app.openDetails(saved.name);
    await expect(
      details
        .getByRole('term')
        .filter({ hasText: app.t('details.fastWebView') })
        .locator('xpath=following-sibling::dd[1]'),
    ).toHaveText(app.t('details.yes'));
  });

  test('both output options together, when locking', async ({ app }) => {
    const source = fixture('plain.pdf');
    const password = 'optimised-and-linear';
    await app.open();
    const settings = await app.openSettings();
    await app.switch('settings.output.optimize', settings).click();
    await app.switch('settings.output.linearize', settings).click();
    await app.closeDialog();

    await app.switchMode('lock');
    await app.addFixtures(source.file);
    await app.expectState(source.file, 'ready', 'lock');
    await app.lockPassword.fill(password);
    await app.lockConfirmation.fill(password);
    await app.lockConfirmation.press('Enter');
    await app.expectState(source.file, 'done', 'lock');
    const saved = await app.saveAll();
    expect(rawFacts(saved.bytes)).toMatchObject({ encryptEntry: true, linearized: true });
    expect(await inspectPdf(saved.bytes, password)).toMatchObject({
      access: 'both',
      pageCount: source.pageCount,
      linearized: true,
      warnings: [],
    });
  });

  test('about: versions, the privacy statement, licences, and how to install', async ({ app }) => {
    await app.open();
    const settings = await app.openSettings();
    await expect(settings.getByRole('heading', { name: app.t('about.title') })).toBeVisible();
    await expect(settings).toContainText(app.t('about.version'));
    await expect(settings).toContainText('1.0.0');
    // The engine reports its own version once it is loaded.
    await expect(settings).toContainText(app.t('about.engine.value', { version: '12.4.2' }));
    await expect(settings).toContainText(app.t('about.privacy'));

    const licences = settings.getByText(app.t('about.licenses'), { exact: true });
    await licences.click();
    await expect(settings).toContainText(app.t('about.licenses.thirdParty'));
    for (const component of ['qpdf', 'zlib', 'Preact', 'Apache-2.0']) {
      await expect(settings.locator('details')).toContainText(component);
    }

    // No install prompt in this browser: the row explains where to find it instead.
    await expect(settings).toContainText(app.t('settings.install'));
    await expect(settings).toContainText(app.t('settings.install.hint'));
    await expect(
      app.page.getByRole('button', { name: app.t('topbar.install'), exact: true }),
    ).toHaveCount(0);
  });

  test('settings are stored, passwords never are', async ({ app, page }) => {
    const source = fixture('aes-256-r6.pdf');
    await app.open();
    const settings = await app.openSettings();
    await app.switch('settings.output.linearize', settings).click();
    await app.closeDialog();
    await app.addFixtures(source.file);
    await app.expectState(source.file, 'needs-password');
    await app.unlockWith('first-wrong-guess');
    await app.expectState(source.file, 'wrong-password');
    await app.unlockWith(source.userPassword!);
    await app.expectState(source.file, 'done');

    const stored = await page.evaluate(async () => ({
      local: JSON.stringify({ ...localStorage }),
      session: JSON.stringify({ ...sessionStorage }),
      databases: (await indexedDB.databases()).map((database) => database.name),
      cookies: document.cookie,
      url: location.href,
    }));
    expect(JSON.parse(stored.local)).toEqual({
      'pdfkey:settings': expect.stringContaining('"linearize":true'),
    });
    expect(stored.session).toBe('{}');
    expect(stored.databases).toEqual([]);
    expect(stored.cookies).toBe('');
    for (const secret of ['first-wrong-guess', source.userPassword!]) {
      expect(stored.local).not.toContain(`"${secret}"`);
      expect(stored.url).not.toContain(secret);
    }

    // A reload starts clean: no files, no password.
    await page.reload();
    await app.ready();
    await expect(app.chooseButton).toBeVisible();
    await expect(app.cards).toHaveCount(0);
  });
});
