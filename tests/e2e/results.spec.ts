/**
 * Getting results out, beyond the plain download the other tests use: opening in a new tab, the
 * system share sheet (Android), and the "save as" and folder pickers of desktop Chrome and Edge.
 *
 * Share sheet and pickers are system dialogs that nothing can drive, so the browser functions
 * behind them are replaced: `navigator.share` records what it is given, and the pickers "choose"
 * a place in the origin-private file system, where the test reads the files back.
 */
import { readFile } from 'node:fs/promises';
import type { Page } from '@playwright/test';
import { expect, test, type App } from './support/app';
import { fixture, unlockedName } from './support/files';
import { expectUnlockedCopy } from './support/pdf';
import { readZip } from './support/zip';

interface SharedFile {
  name: string;
  type: string;
  base64: string;
}

declare global {
  interface Window {
    e2eShares?: SharedFile[][];
    e2eShareFails?: string;
  }
}

/** Gives the page a share sheet, as Chrome on Android has one. */
async function withShareSheet(page: Page): Promise<void> {
  await page.addInitScript(() => {
    window.e2eShares = [];
    const canShare = (data?: ShareData): boolean =>
      (data?.files ?? []).every((file) => file.type === 'application/pdf');
    const share = async (data?: ShareData): Promise<void> => {
      if (window.e2eShareFails) throw new DOMException('refused', window.e2eShareFails);
      const files = await Promise.all(
        (data?.files ?? []).map(async (file) => {
          const bytes = new Uint8Array(await file.arrayBuffer());
          let binary = '';
          for (let i = 0; i < bytes.length; i += 0x8000) {
            binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
          }
          return { name: file.name, type: file.type, base64: btoa(binary) };
        }),
      );
      window.e2eShares!.push(files);
    };
    Object.defineProperty(navigator, 'canShare', { configurable: true, value: canShare });
    Object.defineProperty(navigator, 'share', { configurable: true, value: share });
  });
}

/**
 * The files a picker "saved": everything in the origin-private file system. A file that is being
 * written at this moment is left out (the browser writes into a temporary file and swaps it in),
 * so poll until the files you expect are there.
 */
function pickedFiles(page: Page): Promise<SharedFile[]> {
  return page.evaluate(async () => {
    const root = await navigator.storage.getDirectory();
    const files: SharedFile[] = [];
    // `values()` is not in the TypeScript DOM library yet.
    const entries = (root as unknown as { values(): AsyncIterable<FileSystemFileHandle> }).values();
    for await (const handle of entries) {
      if (handle.name.endsWith('.crswap')) continue;
      try {
        const file = await handle.getFile();
        const bytes = new Uint8Array(await file.arrayBuffer());
        let binary = '';
        for (let i = 0; i < bytes.length; i += 0x8000) {
          binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
        }
        files.push({ name: file.name, type: file.type, base64: btoa(binary) });
      } catch {
        // Gone or not readable yet: in the middle of being written.
      }
    }
    return files.sort((a, b) => a.name.localeCompare(b.name));
  });
}

function bytesOf(file: SharedFile): Buffer {
  return Buffer.from(file.base64, 'base64');
}

async function unlock(app: App, password: string, ...files: string[]): Promise<void> {
  await app.addFixtures(...files);
  await app.analysed(files.length);
  await app.unlockWith(password);
  for (const file of files) await app.expectState(file, 'done');
}

test.describe('open and share', () => {
  test('"open" hands the result to a new tab', async ({ app, context, page, issues }) => {
    // The browser of this suite (headless Chromium) has no PDF viewer: the new tab's navigation
    // to the document becomes a download and is reported as aborted. That download is how the
    // test gets hold of what the tab was given; a browser with a viewer shows it instead.
    issues.allow(/^request failed: GET blob:\S+ \(net::ERR_ABORTED\)$/);
    const source = fixture('aes-256-r6.pdf');
    await app.open();
    await unlock(app, source.userPassword!, source.file);

    const tab = context.waitForEvent('page');
    const given = page.waitForEvent('download');
    await app.press(app.dockButton('entry.open'));
    const download = await given;
    await tab;
    expect(download.url().startsWith(`blob:${new URL(page.url()).origin}/`)).toBe(true);
    await expectUnlockedCopy(await readFile(await download.path()), source);

    // The app is still there, and looking at a result does not count as saving it.
    await expect(app.dock).toContainText(app.t('dock.unsaved'));
    await app.expectState(source.file, 'done');
  });

  test('without a share sheet there is no share button', async ({ app }) => {
    await app.open();
    await unlock(app, 'user', 'aes-256-r6.pdf', 'rc4-128-r3.pdf');
    await expect(app.dockButton('action.saveAll')).toBeVisible();
    await expect(app.dockButton('action.shareAll')).toHaveCount(0);
    await expect(
      app.page.getByRole('button', { name: app.t('entry.share'), exact: true }),
    ).toHaveCount(0);
  });

  test('with a share sheet, one result or all of them can be shared', async ({ app, page }) => {
    const first = fixture('aes-256-r6.pdf');
    const second = fixture('rc4-128-r3.pdf');
    await withShareSheet(page);
    await app.open();
    await unlock(app, 'user', first.file);

    await app.press(app.dockButton('entry.share'));
    await expect.poll(() => page.evaluate(() => window.e2eShares!.length)).toBe(1);
    const [single] = await page.evaluate(() => window.e2eShares!);
    expect(single!.map((file) => [file.name, file.type])).toEqual([
      [unlockedName(first.file), 'application/pdf'],
    ]);
    await expectUnlockedCopy(bytesOf(single![0]!), first);

    // Several results: each card shares its own file, the action area shares all of them.
    await app.addFixtures(second.file);
    await app.expectState(second.file, 'needs-password');
    await app.unlockWith('user');
    await app.expectState(second.file, 'done');
    await app
      .card(second.file)
      .getByRole('button', { name: app.t('entry.share'), exact: true })
      .click();
    await expect.poll(() => page.evaluate(() => window.e2eShares!.length)).toBe(2);
    await app.press(app.dockButton('action.shareAll'));
    await expect.poll(() => page.evaluate(() => window.e2eShares!.length)).toBe(3);
    const shares = await page.evaluate(() => window.e2eShares!);
    expect(shares[1]!.map((file) => file.name)).toEqual([unlockedName(second.file)]);
    expect(shares[2]!.map((file) => file.name)).toEqual([
      unlockedName(first.file),
      unlockedName(second.file),
    ]);
    await expectUnlockedCopy(bytesOf(shares[2]![1]!), second);

    // Dismissing the sheet is not an error; a refusal by the system points to saving instead.
    await page.evaluate(() => {
      window.e2eShareFails = 'AbortError';
    });
    await app.press(app.dockButton('action.shareAll'));
    await page.evaluate(() => {
      window.e2eShareFails = 'NotAllowedError';
    });
    await app.press(app.dockButton('action.shareAll'));
    await app.expectToast('toast.shareUnsupported');
    await expect(app.toasts).not.toContainText(app.t('toast.shareFailed'));
  });
});

test.describe('save with the pickers of desktop Chrome and Edge', () => {
  test.use({ filePickers: 'opfs' });

  test('one result goes where "save as" says, under its own name', async ({ app, page }) => {
    const source = fixture('aes-256-r6.pdf');
    let downloads = 0;
    page.on('download', () => downloads++);
    await app.open();
    await unlock(app, source.userPassword!, source.file);

    await app.press(app.dockButton('entry.save'));
    // "Saved", not "download started": the file is where the user put it.
    await app.expectToast('toast.saved');
    await expect(app.dock).toContainText(app.t('dock.saved'));
    const files = await pickedFiles(page);
    expect(files.map((file) => file.name)).toEqual([unlockedName(source.file)]);
    await expectUnlockedCopy(bytesOf(files[0]!), source);
    expect(downloads).toBe(0);
  });

  test('several results can be written into a folder, or bundled into one ZIP', async ({
    app,
    page,
  }) => {
    const sources = [
      fixture('aes-256-r6.pdf'),
      fixture('rc4-128-r3.pdf'),
      fixture('aes-128-r4.pdf'),
    ];
    await app.open();
    await unlock(app, 'user', ...sources.map((source) => source.file));
    await expect(app.dock).toContainText(app.t('dock.zipHint'));

    await app.press(app.dockButton('action.saveAllFolder'));
    await app.expectToast('toast.savedCount', { count: 3 });
    let files = await pickedFiles(page);
    expect(files.map((file) => file.name)).toEqual(
      sources.map((source) => unlockedName(source.file)).sort(),
    );
    for (const source of sources) {
      const file = files.find((candidate) => candidate.name === unlockedName(source.file))!;
      await expectUnlockedCopy(bytesOf(file), source);
    }
    for (const source of sources) {
      await expect(app.card(source.file)).toContainText(app.t('entry.saved'));
    }

    // Saving into the same folder again overwrites nothing: the new files get a counter.
    await app.press(app.dockButton('action.saveAllFolder'));
    // (A file shows up in the folder empty and gets its content a moment later: wait for both.)
    const written = async (): Promise<string[]> =>
      (await pickedFiles(page)).filter((file) => file.base64 !== '').map((file) => file.name);
    await expect
      .poll(written)
      .toEqual(
        sources
          .flatMap((source) => [
            unlockedName(source.file),
            unlockedName(source.file).replace('.pdf', ' (2).pdf'),
          ])
          .sort(),
      );
    files = await pickedFiles(page);
    for (const source of sources) {
      const copy = unlockedName(source.file).replace('.pdf', ' (2).pdf');
      await expectUnlockedCopy(bytesOf(files.find((file) => file.name === copy)!), source);
    }

    // The primary button still makes one ZIP, through "save as".
    const zipName = `${app.t('zip.unlocked')}.zip`;
    await app.press(app.dockButton('action.saveAll'));
    await expect.poll(written).toContain(zipName);
    const archive = (await pickedFiles(page)).find((file) => file.name === zipName)!;
    expect(readZip(bytesOf(archive)).map((entry) => entry.name)).toEqual(
      sources.map((source) => unlockedName(source.file)),
    );
  });

  test('a dismissed "save as" saves nothing and says nothing', async ({ app, page }) => {
    const source = fixture('aes-256-r6.pdf');
    await page.addInitScript(() => {
      // After the fixture's picker: this one is dismissed by the user.
      (window as unknown as Record<string, unknown>).showSaveFilePicker = () =>
        Promise.reject(new DOMException('The user aborted a request.', 'AbortError'));
    });
    await app.open();
    await unlock(app, source.userPassword!, source.file);
    await app.press(app.dockButton('entry.save'));
    await expect(app.dock).toContainText(app.t('dock.unsaved'));
    expect(await pickedFiles(page)).toEqual([]);
    await expect(app.toasts).toBeEmpty();
  });
});
