/**
 * How files get into the app from the page: the file picker, drag and drop, paste, the keyboard
 * shortcut — and what is turned away (other file types, duplicates) or taken out again.
 */
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { JSHandle, Page } from '@playwright/test';
import { expect, test } from './support/app';
import { fixturePath } from './support/files';

interface Payload {
  name: string;
  type: string;
  base64: string;
}

function payload(fixtureName: string, as?: { name?: string; type?: string }): Payload {
  return {
    name: as?.name ?? fixtureName,
    type: as?.type ?? 'application/pdf',
    base64: readFileSync(fixturePath(fixtureName)).toString('base64'),
  };
}

/** A DataTransfer carrying files, as a drag from the file manager or a paste would. */
function transferWith(page: Page, files: readonly Payload[]): Promise<JSHandle<DataTransfer>> {
  return page.evaluateHandle((items) => {
    const transfer = new DataTransfer();
    for (const item of items) {
      const bytes = Uint8Array.from(atob(item.base64), (char) => char.charCodeAt(0));
      transfer.items.add(new File([bytes], item.name, { type: item.type }));
    }
    return transfer;
  }, files);
}

/** Dispatches a drag event at the page; resolves to whether the app claimed it. */
function drag(page: Page, type: string, transfer: JSHandle<DataTransfer>): Promise<boolean> {
  return page.evaluate(
    ([eventType, dataTransfer]) => {
      const event = new DragEvent(eventType, { dataTransfer, bubbles: true, cancelable: true });
      (document.elementFromPoint(100, 300) ?? document.body).dispatchEvent(event);
      return event.defaultPrevented;
    },
    [type, transfer] as const,
  );
}

test.describe('getting files in', () => {
  test('drag and drop: the overlay appears, the drop adds the files', async ({ app, page }) => {
    await app.open();
    const overlay = page.getByText(app.t('drop.title'), { exact: true });
    await expect(overlay).toHaveCount(0);

    const transfer = await transferWith(page, [payload('aes-256-r6.pdf'), payload('plain.pdf')]);
    expect(await drag(page, 'dragenter', transfer)).toBe(true);
    await expect(overlay).toBeVisible();
    await expect(page.getByText(app.t('drop.subtitle'), { exact: true }).last()).toBeVisible();
    expect(await drag(page, 'dragover', transfer)).toBe(true);
    await expect(overlay).toBeVisible();

    // Claimed, so the browser does not navigate to the file instead.
    expect(await drag(page, 'drop', transfer)).toBe(true);
    await expect(overlay).toHaveCount(0);
    await app.analysed(2);
    await app.expectState('aes-256-r6.pdf', 'needs-password');
    await app.expectState('plain.pdf', 'not-encrypted');

    // More files can be dropped onto the list.
    const more = await transferWith(page, [payload('owner-only-r6.pdf')]);
    await drag(page, 'dragenter', more);
    await expect(overlay).toBeVisible();
    await drag(page, 'drop', more);
    await expect(overlay).toHaveCount(0);
    await app.analysed(3);
    await app.expectState('owner-only-r6.pdf', 'restricted');
  });

  test('a dropped folder adds the PDFs inside it, and is never a card itself', async ({
    app,
    page,
    context,
    browserName,
  }, testInfo) => {
    // Folders are dragged in from a desktop file manager. The drag is a real one, performed by
    // the browser itself (only that hands the page a directory), which only Chromium offers.
    test.skip(app.phone || browserName !== 'chromium', 'a desktop gesture');
    const folder = testInfo.outputPath('statements');
    mkdirSync(path.join(folder, '2024', 'archive'), { recursive: true });
    mkdirSync(path.join(folder, 'pictures'), { recursive: true });
    copyFileSync(fixturePath('plain.pdf'), path.join(folder, 'summary.pdf'));
    copyFileSync(fixturePath('aes-256-r6.pdf'), path.join(folder, '2024', 'march.pdf'));
    copyFileSync(fixturePath('owner-only-r6.pdf'), path.join(folder, '2024', 'archive', 'old.PDF'));
    writeFileSync(path.join(folder, 'notes.txt'), 'not a PDF, and nobody claims it is');
    copyFileSync(fixturePath('not-a-pdf.bin'), path.join(folder, 'pictures', 'scan.jpg'));

    await app.open();
    const session = await context.newCDPSession(page);
    const drop = async (paths: string[]): Promise<void> => {
      const data = { items: [], files: paths, dragOperationsMask: 1 };
      for (const type of ['dragEnter', 'dragOver', 'drop'] as const) {
        await session.send('Input.dispatchDragEvent', { type, x: 400, y: 400, data });
      }
    };

    // The folder and a loose file in one drop.
    await drop([folder, fixturePath('objstm-plain.pdf')]);
    await app.analysed(4);
    await app.expectState('objstm-plain.pdf', 'not-encrypted');
    await app.expectState('summary.pdf', 'not-encrypted');
    await app.expectState('march.pdf', 'needs-password');
    await app.expectState('old.PDF', 'restricted');
    await expect(app.card('statements')).toHaveCount(0);
    // The other files in the folder are passed over without a word.
    await expect(app.toasts).not.toContainText(app.t('toast.notPdfCount', { count: 2 }));
    await expect(app.toasts).not.toContainText('notes.txt');
    await expect(app.toasts).not.toContainText('scan.jpg');

    // A folder without PDFs adds nothing and says why.
    await drop([path.join(folder, 'pictures')]);
    await app.expectToast('toast.folderEmpty');
    await expect(app.cards).toHaveCount(4);
  });

  test('a drag that leaves, or simply stops, takes the overlay away again', async ({
    app,
    page,
  }) => {
    await app.open();
    const overlay = page.getByText(app.t('drop.title'), { exact: true });
    const transfer = await transferWith(page, [payload('plain.pdf')]);

    await drag(page, 'dragenter', transfer);
    await expect(overlay).toBeVisible();
    await drag(page, 'dragleave', transfer);
    await expect(overlay).toHaveCount(0);

    // A drag that ended without telling the page (left the window, Escape): no event at all.
    await drag(page, 'dragenter', transfer);
    await expect(overlay).toBeVisible();
    await expect(overlay).toHaveCount(0);
    await expect(app.cards).toHaveCount(0);
  });

  test('dragging text over the page is none of the app’s business', async ({ app, page }) => {
    await app.open();
    const claimed = await page.evaluate(() => {
      const transfer = new DataTransfer();
      transfer.setData('text/plain', 'just some text');
      return ['dragenter', 'dragover', 'drop'].map((type) => {
        const event = new DragEvent(type, {
          dataTransfer: transfer,
          bubbles: true,
          cancelable: true,
        });
        document.body.dispatchEvent(event);
        return event.defaultPrevented;
      });
    });
    expect(claimed).toEqual([false, false, false]);
    await expect(page.getByText(app.t('drop.title'), { exact: true })).toHaveCount(0);
    await expect(app.chooseButton).toBeVisible();
  });

  test('pasting files adds them; pasting text into the password field still works', async ({
    app,
    page,
    context,
  }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await app.open();
    const transfer = await transferWith(page, [payload('aes-256-r6.pdf')]);
    const claimed = await page.evaluate((clipboardData) => {
      const event = new ClipboardEvent('paste', {
        clipboardData,
        bubbles: true,
        cancelable: true,
      });
      document.body.dispatchEvent(event);
      return event.defaultPrevented;
    }, transfer);
    expect(claimed).toBe(true);
    await app.expectState('aes-256-r6.pdf', 'needs-password');

    // A real paste of text (a password from a password manager) goes into the field untouched.
    await page.evaluate(() => navigator.clipboard.writeText('user'));
    await app.unlockField.focus();
    await page.keyboard.press('ControlOrMeta+V');
    await expect(app.unlockField).toHaveValue('user');
    await app.unlockField.press('Enter');
    await app.expectState('aes-256-r6.pdf', 'done');
  });

  for (const shortcut of ['Control+o', 'Meta+o']) {
    test(`${shortcut} opens the file picker`, async ({ app, page }) => {
      await app.open();
      const chooser = page.waitForEvent('filechooser');
      await page.keyboard.press(shortcut);
      const picker = await chooser;
      expect(picker.isMultiple()).toBe(true);
      expect(await picker.element().getAttribute('accept')).toBe('application/pdf,.pdf');
      await picker.setFiles(fixturePath('plain.pdf'));
      await app.expectState('plain.pdf', 'not-encrypted');
    });
  }

  test('the whole empty state is a target, and "add files" adds to the list', async ({
    app,
    page,
  }) => {
    await app.open();
    // Not only the button: tapping the illustration or the text picks files as well.
    await app.choose(page.getByRole('heading', { level: 2, name: app.t('empty.unlock.title') }), [
      fixturePath('plain.pdf'),
    ]);
    await app.expectState('plain.pdf', 'not-encrypted');
    await expect(app.chooseButton).toHaveCount(0);

    await app.choose(app.addButton, [fixturePath('aes-256-r6.pdf'), fixturePath('rc4-40-r2.pdf')]);
    await app.analysed(3);
    await expect(page.getByRole('heading', { level: 2 }).first()).toContainText(
      app.t('format.files', { count: 3 }),
    );
  });

  test('a file that is not a PDF is turned away with a message', async ({ app }) => {
    await app.open();
    await app.addFixtures('not-a-pdf.bin');
    await app.expectToast('toast.notPdf', { name: 'not-a-pdf.bin' });
    await expect(app.cards).toHaveCount(0);
    await expect(app.chooseButton).toBeVisible();

    // Several at once: one message, and the PDFs among them are still taken.
    await app.addFixtures('not-a-pdf.bin', 'text-not-pdf.bin', 'plain.pdf');
    await app.expectToast('toast.notPdfCount', { count: 2 });
    await app.analysed(1);
    await app.expectState('plain.pdf', 'not-encrypted');
  });

  test('a ".pdf" that is not a PDF is judged by its content, not its name', async ({ app }) => {
    await app.open();
    const chooser = app.page.waitForEvent('filechooser');
    await app.chooseButton.click();
    await (
      await chooser
    ).setFiles([
      {
        // A text file with a PDF name and a PDF type.
        name: 'renamed.pdf',
        mimeType: 'application/pdf',
        buffer: readFileSync(fixturePath('text-not-pdf.bin')),
      },
      {
        // Starts like a PDF and then is nothing of the kind: only the engine can tell.
        name: 'header-only.pdf',
        mimeType: 'application/pdf',
        buffer: Buffer.from('%PDF-1.7\nthis is where a document would be\n'),
      },
      {
        // A real PDF under a name and type that say otherwise.
        name: 'document.bin',
        mimeType: 'application/octet-stream',
        buffer: readFileSync(fixturePath('plain.pdf')),
      },
    ]);
    await app.expectToast('toast.notPdf', { name: 'renamed.pdf' });
    await app.analysed(2);
    await expect(app.card('renamed.pdf')).toHaveCount(0);
    await app.expectState('header-only.pdf', 'error');
    await expect(app.card('header-only.pdf').locator('.problem__title')).not.toBeEmpty();
    await app.expectState('document.bin', 'not-encrypted');
  });

  test('a file that is already in the list is not added twice', async ({ app }) => {
    await app.open();
    await app.addFixtures('aes-256-r6.pdf');
    await app.expectState('aes-256-r6.pdf', 'needs-password');
    await app.addFixtures('aes-256-r6.pdf');
    await app.expectToast('toast.duplicate', { name: 'aes-256-r6.pdf' });
    await expect(app.cards).toHaveCount(1);

    await app.addFixtures('plain.pdf');
    await app.analysed(2);
    await app.addFixtures('aes-256-r6.pdf', 'plain.pdf', 'rc4-40-r2.pdf');
    await app.expectToast('toast.duplicateCount', { count: 2 });
    await app.analysed(3);
  });

  test('files are removed one by one from their menu, the last one empties the list', async ({
    app,
  }) => {
    await app.open();
    await app.addFixtures('aes-256-r6.pdf', 'plain.pdf');
    await app.analysed(2);

    await app.menuCommand('plain.pdf', 'entry.menu.remove');
    await expect(app.cards).toHaveCount(1);
    await expect(app.card('plain.pdf')).toHaveCount(0);
    await app.expectState('aes-256-r6.pdf', 'needs-password');

    await app.menuCommand('aes-256-r6.pdf', 'entry.menu.remove');
    await expect(app.cards).toHaveCount(0);
    await expect(app.chooseButton).toBeVisible();

    // A removed file can be added again: it is no duplicate any more.
    await app.addFixtures('plain.pdf');
    await app.expectState('plain.pdf', 'not-encrypted');
  });

  test('"clear" empties the list and forgets what was typed', async ({ app, page }) => {
    await app.open();
    await app.addFixtures('aes-256-r6.pdf', 'aes-128-r4.pdf', 'plain.pdf');
    await app.analysed(3);
    await app.unlockField.fill('half-typed');

    await page.getByRole('button', { name: app.t('action.clear'), exact: true }).click();
    await expect(app.cards).toHaveCount(0);
    await expect(app.chooseButton).toBeVisible();

    await app.addFixtures('aes-256-r6.pdf');
    await app.expectState('aes-256-r6.pdf', 'needs-password');
    await expect(app.unlockField).toHaveValue('');
  });

  test('switching the mode keeps the files, each mode with its own view of them', async ({
    app,
  }) => {
    await app.open();
    await app.addFixtures('aes-256-r6.pdf', 'plain.pdf', 'owner-only-r6.pdf');
    await app.analysed(3);
    await app.unlockField.fill('user');

    await app.switchMode('lock');
    await expect(app.cards).toHaveCount(3);
    await app.expectState('aes-256-r6.pdf', 'encrypted', 'lock');
    await app.expectState('plain.pdf', 'ready', 'lock');
    await app.expectState('owner-only-r6.pdf', 'encrypted', 'lock');
    await expect(app.lockPassword).toBeVisible();
    await expect(app.dockButton('action.lockCount', { count: 2 })).toBeVisible();

    await app.switchMode('unlock');
    await expect(app.cards).toHaveCount(3);
    await app.expectState('aes-256-r6.pdf', 'needs-password');
    await app.expectState('plain.pdf', 'not-encrypted');
    await app.expectState('owner-only-r6.pdf', 'restricted');
    // What was typed is still there.
    await expect(app.unlockField).toHaveValue('user');

    // Results belong to the mode that made them.
    await app.unlockField.press('Enter');
    await app.expectState('aes-256-r6.pdf', 'done');
    await app.expectState('owner-only-r6.pdf', 'done');
    await app.switchMode('lock');
    await app.expectState('aes-256-r6.pdf', 'encrypted', 'lock');
    await app.switchMode('unlock');
    await app.expectState('aes-256-r6.pdf', 'done');
  });

  test('a list with nothing to unlock offers to lock instead', async ({ app }) => {
    await app.open();
    await app.addFixtures('plain.pdf');
    await app.expectState('plain.pdf', 'not-encrypted');
    await expect(app.dock).toContainText(app.t('status.nothingToUnlock'));
    await app.press(app.dockButton('action.switchToLock'));
    await expect(app.modeOption('lock')).toBeChecked();
    await app.expectState('plain.pdf', 'ready', 'lock');
    await expect(app.lockPassword).toBeVisible();
  });
});
