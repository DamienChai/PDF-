/**
 * Unlock mode, one file at a time: the main job of the app. Real fixtures, the real engine, and
 * every saved file is checked outside the browser.
 */
import { expect, test } from './support/app';
import { fixture, unlockedName } from './support/files';
import { expectUnlockedCopy } from './support/pdf';

test.describe('unlock one file', () => {
  test('a wrong password is rejected in place, the right one gives an unprotected copy', async ({
    app,
    page,
  }) => {
    const source = fixture('aes-256-r6.pdf');
    let downloads = 0;
    page.on('download', () => downloads++);

    await app.open();
    await app.addFixtures(source.file);

    // The card says what the file is and what it needs.
    await app.expectState(source.file, 'needs-password');
    await expect(app.card(source.file)).toContainText('AES-256');
    await expect(app.unlockField).toBeFocused();
    await expect(app.unlockField).toHaveAttribute('enterkeyhint', 'go');
    await expect(app.unlockField).toHaveAttribute('type', 'password');
    const unlock = app.dockButton('action.unlock');
    await expect(unlock).toBeVisible();

    // A wrong password: said next to the field, which is ready to be typed over.
    await app.unlockWith(source.wrongPassword);
    await expect(app.dock).toContainText(app.t('unlock.password.wrong'));
    await app.expectState(source.file, 'wrong-password');
    await expect(app.unlockField).toBeFocused();
    await expect(app.unlockField).toHaveAttribute('aria-invalid', 'true');
    await expect(app.unlockField).toHaveValue(source.wrongPassword);
    expect(
      await app.unlockField.evaluate(
        (field: HTMLInputElement) => field.selectionEnd! - field.selectionStart!,
      ),
      'the rejected password is selected',
    ).toBe(source.wrongPassword.length);
    await expect(app.dockButton('entry.save')).toHaveCount(0);
    expect(downloads).toBe(0);

    // Typing clears the error; the right password unlocks.
    await app.unlockField.fill(source.userPassword!);
    await expect(app.dock).not.toContainText(app.t('unlock.password.wrong'));
    await app.unlockField.press('Enter');
    await app.expectState(source.file, 'done');
    await expect(app.card(source.file)).toContainText(unlockedName(source.file));
    await expect(app.dock).toContainText(app.t('status.unlocked', { count: 1 }));
    await expect(app.dock).toContainText(app.t('dock.done.unlock'));
    await expect(app.unlockField).toHaveCount(0);

    // Save: a download with the expected name, an unencrypted PDF with the same pages.
    const saved = await app.saveAll();
    expect(saved.name).toBe('aes-256-r6_unlocked.pdf');
    expect(downloads).toBe(1);
    await app.expectToast('toast.downloaded');
    await expect(app.dock).toContainText(app.t('dock.saved'));
    await expectUnlockedCopy(saved.bytes, source);

    // Black box: the app itself finds nothing left to unlock in what it produced.
    await app.startOver();
    await app.addFiles([saved.path]);
    await app.expectState(saved.name, 'not-encrypted');
    await expect(app.card(saved.name)).toContainText(
      app.t('format.pages', { count: source.pageCount }),
    );
    await expect(app.dock).toContainText(app.t('status.nothingToUnlock'));
    await expect(app.unlockField).toHaveCount(0);
  });

  test('the button unlocks too, and asks for a password when there is none', async ({ app }) => {
    const source = fixture('aes-128-r4.pdf');
    await app.open();
    await app.addFixtures(source.file);
    await app.expectState(source.file, 'needs-password');

    // Nothing typed: pressing the button points at the field instead of doing nothing.
    const unlock = app.dockButton('action.unlock');
    await expect(unlock).toHaveAttribute('aria-disabled', 'true');
    await app.unlockField.blur();
    // (Forced: to Playwright a button that says it is unavailable is not clickable.)
    await unlock.click({ force: true });
    await expect(app.unlockField).toBeFocused();
    await app.expectState(source.file, 'needs-password');

    // Show / hide the password.
    await app.unlockField.fill(source.userPassword!);
    await app.dock.getByRole('button', { name: app.t('password.show'), exact: true }).click();
    await expect(app.unlockField).toHaveAttribute('type', 'text');
    await app.dock.getByRole('button', { name: app.t('password.hide'), exact: true }).click();
    await expect(app.unlockField).toHaveAttribute('type', 'password');

    await expect(unlock).not.toHaveAttribute('aria-disabled', 'true');
    await app.press(unlock);
    await app.expectState(source.file, 'done');
    const saved = await app.saveAll();
    expect(saved.name).toBe(unlockedName(source.file));
    await expectUnlockedCopy(saved.bytes, source);
  });

  // One fixture per algorithm and per kind of password: how the password was stored in the file
  // decides whether what the user types opens it.
  const REPRESENTATIVE: readonly { file: string; chip: string; why: string }[] = [
    { file: 'rc4-40-r2.pdf', chip: 'RC4-40', why: 'RC4 40-bit' },
    { file: 'rc4-128-r3.pdf', chip: 'RC4-128', why: 'RC4 128-bit' },
    { file: 'aes-128-r4.pdf', chip: 'AES-128', why: 'AES-128' },
    { file: 'aes-256-r5.pdf', chip: 'AES-256', why: 'AES-256, deprecated R5' },
    { file: 'unicode-saslprep-r6.pdf', chip: 'AES-256', why: 'Unicode password, normalised' },
    { file: 'unicode-raw-r6.pdf', chip: 'AES-256', why: 'Unicode password, stored as typed' },
    { file: 'unicode-nfd-r5.pdf', chip: 'AES-256', why: 'password stored decomposed' },
    { file: 'gbk-r3.pdf', chip: 'RC4-128', why: 'Chinese password stored as GBK bytes' },
    { file: 'pdfdoc-r4.pdf', chip: 'AES-128', why: 'PDFDocEncoding password' },
    { file: 'long-password-r4.pdf', chip: 'AES-128', why: 'longer than 32 bytes' },
    { file: 'attachment-r6.pdf', chip: 'AES-256', why: 'with an attachment' },
    { file: 'reportlab-rc4-128.pdf', chip: 'RC4-128', why: 'written by ReportLab' },
    { file: 'pypdf-aes-256.pdf', chip: 'AES-256', why: 'written by pypdf' },
  ];

  for (const { file, chip, why } of REPRESENTATIVE) {
    test(`${file} (${why}) unlocks with its password`, async ({ app }) => {
      const source = fixture(file);
      await app.open();
      await app.addFixtures(source.file);
      await app.expectState(source.file, 'needs-password');
      await expect(app.card(source.file)).toContainText(chip);

      await app.unlockWith(source.userPassword!);
      await app.expectState(source.file, 'done');
      const saved = await app.saveAll();
      expect(saved.name).toBe(unlockedName(source.file));
      await expectUnlockedCopy(saved.bytes, source);
    });
  }

  test('the permissions password opens a file as well', async ({ app }) => {
    const source = fixture('aes-256-r6.pdf');
    await app.open();
    await app.addFixtures(source.file);
    await app.expectState(source.file, 'needs-password');
    await app.unlockWith(source.ownerPassword!);
    await app.expectState(source.file, 'done');
    await expectUnlockedCopy((await app.saveAll()).bytes, source);
  });

  test('a damaged but readable file is repaired and says so', async ({ app }) => {
    const source = fixture('damaged-recoverable-r4.pdf');
    await app.open();
    await app.addFixtures(source.file);
    await app.expectState(source.file, 'needs-password');
    await app.unlockWith(source.userPassword!);
    await app.expectState(source.file, 'done');
    const saved = await app.saveAll();
    await expectUnlockedCopy(saved.bytes, source);

    const details = await app.openDetails(source.file);
    await expect(details.getByRole('heading', { name: app.t('details.warnings') })).toBeVisible();
    // qpdf reports three things about this file: damaged, no cross-reference table, rebuilt.
    await expect(details).toContainText(app.t('entry.warnings', { count: 3 }));
    await expect(details).toContainText('reconstruct cross-reference table');
  });
});

test.describe('a file that only carries restrictions', () => {
  test('is freed with one tap, without a password', async ({ app }) => {
    const source = fixture('owner-only-r6.pdf');
    await app.open();
    await app.addFixtures(source.file);

    await app.expectState(source.file, 'restricted');
    // What is restricted, in words.
    await expect(app.card(source.file)).toContainText(app.t('restriction.print'));
    await expect(app.card(source.file)).toContainText(app.t('restriction.extract'));
    await expect(app.card(source.file)).toContainText(
      app.t('format.pages', { count: source.pageCount }),
    );
    // No password anywhere: one button.
    await expect(app.dock.locator('input')).toHaveCount(0);
    await expect(app.dock).toContainText(app.t('dock.noPassword.headline'));
    const free = app.dockButton('action.removeRestrictions');
    await expect(free).toBeEnabled();

    await app.press(free);
    await app.expectState(source.file, 'done');
    await expect(app.dock).toContainText(app.t('dock.done.restrictions'));

    const saved = await app.saveAll();
    expect(saved.name).toBe(unlockedName(source.file));
    await expectUnlockedCopy(saved.bytes, source);

    // The copy has no restrictions left: the details list every permission as allowed.
    await app.startOver();
    await app.addFiles([saved.path]);
    await app.expectState(saved.name, 'not-encrypted');
    const details = await app.openDetails(saved.name);
    await expect(details).toContainText(app.t('details.permissions.all'));
    await expect(details.getByRole('listitem')).toHaveCount(7);
    await expect(
      details.getByRole('listitem').filter({ hasText: app.t('permission.allowed') }),
    ).toHaveCount(7);
  });

  for (const file of ['owner-only-r3.pdf', 'owner-only-r4.pdf']) {
    test(`${file}: restrictions are removed without a password`, async ({ app }) => {
      const source = fixture(file);
      await app.open();
      await app.addFixtures(source.file);
      await app.expectState(source.file, 'restricted');
      await app.press(app.dockButton('action.removeRestrictions'));
      await app.expectState(source.file, 'done');
      await expectUnlockedCopy((await app.saveAll()).bytes, source);
    });
  }
});
