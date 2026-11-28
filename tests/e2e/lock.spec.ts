/**
 * Lock mode: add a password, choose the algorithm and the permissions, replace existing
 * protection. Every produced file is opened again, by the engine outside the browser and by the
 * app itself in Unlock mode.
 */
import { expect, test, type App, type SavedFile } from './support/app';
import { fixture, lockedName, unlockedName } from './support/files';
import { expectUnlockedCopy, inspectPdf, rawFacts } from './support/pdf';
import { readZip } from './support/zip';
import type { Permissions } from '../../src/engine/types';

const EVERYTHING_ALLOWED: Permissions = {
  print: 'full',
  modify: true,
  extract: true,
  annotate: true,
  fillForms: true,
  assemble: true,
  accessibility: true,
};

async function startLocking(app: App, ...files: string[]): Promise<void> {
  await app.open();
  await app.switchMode('lock');
  await app.addFixtures(...files);
  await app.analysed(files.length);
}

async function lockAndSave(app: App, file: string): Promise<SavedFile> {
  await app.press(app.dockButton('action.lock'));
  await app.expectState(file, 'done', 'lock');
  return app.saveAll();
}

test.describe('lock a file', () => {
  test('a mismatching confirmation blocks, a matching one locks; the copy needs the password', async ({
    app,
  }) => {
    const source = fixture('plain.pdf');
    const password = 'Tr1cky-密码 for e2e';
    await startLocking(app, source.file);

    await app.expectState(source.file, 'ready', 'lock');
    await expect(app.card(source.file)).toContainText(app.t('entry.note.willEncrypt'));
    // The warning that cannot be missed: a forgotten password is gone for good.
    await expect(app.dock).toContainText(app.t('lock.warning'));

    // Strength meter: a weak password is called weak, with a hint. A name with a year is one.
    await app.lockPassword.fill('1234');
    await expect(app.dock).toContainText(app.t('strength.0'));
    await app.lockPassword.fill('Zhangwei1990');
    await expect(app.dock).toContainText(app.t('strength.0'));
    await expect(app.dock).toContainText(app.t('strength.hint.name-or-word'));
    await app.lockPassword.fill(password);
    await expect(app.dock).not.toContainText(app.t('strength.0'));

    // Confirmation differs: nothing is processed, the problem is named, the field has the focus.
    await app.lockConfirmation.fill('something else');
    await app.lockConfirmation.press('Enter');
    await expect(app.dock.getByRole('alert')).toHaveText(app.t('lock.error.mismatch'));
    await expect(app.lockConfirmation).toBeFocused();
    await expect(app.lockConfirmation).toHaveAttribute('aria-invalid', 'true');
    await app.expectState(source.file, 'ready', 'lock');

    // Matching: locked with AES-256.
    await app.lockConfirmation.fill(password);
    await expect(app.dock.getByRole('alert')).toHaveCount(0);
    await app.lockConfirmation.press('Enter');
    await app.expectState(source.file, 'done', 'lock');
    await expect(app.card(source.file)).toContainText('AES-256');
    await expect(app.card(source.file)).toContainText(lockedName(source.file));
    await expect(app.dock).toContainText(app.t('status.locked', { count: 1 }));
    await expect(app.dock).toContainText(app.t('lock.warning'));

    const saved = await app.saveAll();
    expect(saved.name).toBe('plain_locked.pdf');
    expect(rawFacts(saved.bytes)).toMatchObject({
      header: true,
      endMarker: true,
      encryptEntry: true,
    });

    // Outside the browser: locked without the password, open with it, AES-256, nothing restricted.
    expect(await inspectPdf(saved.bytes)).toMatchObject({
      encrypted: true,
      access: 'locked',
      opensWithoutPassword: false,
      pageCount: null,
    });
    expect(await inspectPdf(saved.bytes, 'wrong')).toMatchObject({ access: 'locked' });
    expect(await inspectPdf(saved.bytes, password)).toMatchObject({
      access: 'both',
      pageCount: source.pageCount,
      encryption: {
        algorithm: 'aes-256',
        keyBits: 256,
        revision: 6,
        encryptMetadata: true,
        permissions: EVERYTHING_ALLOWED,
      },
    });

    // In the app: Unlock mode asks for exactly that password and gives the original back.
    await app.startOver();
    await app.switchMode('unlock');
    await app.addFiles([saved.path]);
    await app.expectState(saved.name, 'needs-password');
    await expect(app.card(saved.name)).toContainText('AES-256');
    await app.unlockWith('not the password');
    await app.expectState(saved.name, 'wrong-password');
    await app.unlockWith(password);
    await app.expectState(saved.name, 'done');
    const unlocked = await app.saveAll();
    // The suffix is swapped, not stacked.
    expect(unlocked.name).toBe(unlockedName(source.file));
    await expectUnlockedCopy(unlocked.bytes, source);
  });

  test('Enter in the password field goes on to the confirmation and reports nothing', async ({
    app,
  }) => {
    const password = 'correct horse 42';
    await startLocking(app, 'plain.pdf');
    await expect(app.lockPassword).toHaveAttribute('enterkeyhint', 'next');
    await app.lockPassword.fill(password);
    await app.lockPassword.press('Enter');

    // Not a submit attempt: nothing is missing yet, the confirmation simply comes next.
    await expect(app.lockConfirmation).toBeFocused();
    await expect(app.dock.getByRole('alert')).toHaveCount(0);
    await app.expectState('plain.pdf', 'ready', 'lock');

    // Typing it does not report a mismatch at every character on the way.
    await app.lockConfirmation.pressSequentially(password.slice(0, -1));
    await expect(app.dock.getByRole('alert')).toHaveCount(0);
    await expect(app.lockConfirmation).toHaveAttribute('aria-invalid', 'false');
    await app.lockConfirmation.pressSequentially(password.slice(-1));

    // With the confirmation typed, Enter submits from either field.
    await expect(app.lockPassword).toHaveAttribute('enterkeyhint', 'go');
    await app.lockPassword.press('Enter');
    await app.expectState('plain.pdf', 'done', 'lock');
  });

  test('Enter locks at once when the password is shown and needs no confirmation', async ({
    app,
  }) => {
    await startLocking(app, 'plain.pdf');
    // The toggle of the password field; the confirmation has one of its own.
    await app.dock
      .getByRole('button', { name: app.t('password.show'), exact: true })
      .first()
      .click();
    await expect(app.lockConfirmation).toHaveCount(0);
    await expect(app.lockPassword).toHaveAttribute('enterkeyhint', 'go');
    await app.lockPassword.fill('shown while typing 7');
    await app.lockPassword.press('Enter');
    await app.expectState('plain.pdf', 'done', 'lock');
  });

  test('an empty form is refused with a message at the password field', async ({ app }) => {
    await startLocking(app, 'plain.pdf');
    await app.dockButton('action.lock').click({ force: true });
    await expect(app.dock.getByRole('alert')).toHaveText(app.t('lock.error.required'));
    await expect(app.lockPassword).toBeFocused();
    await app.expectState('plain.pdf', 'ready', 'lock');
  });

  test('a generated password is shown, can be copied, and opens the file', async ({
    app,
    context,
    page,
  }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    const source = fixture('plain.pdf');
    await startLocking(app, source.file);

    await app.dock.getByRole('button', { name: app.t('lock.generate'), exact: true }).click();
    // Filled in, shown, and nobody is asked to retype twenty random characters.
    await expect(app.lockPassword).toHaveAttribute('type', 'text');
    const generated = await app.lockPassword.inputValue();
    expect(generated).toMatch(/^[\x21-\x7e]{20}$/);
    await expect(app.lockConfirmation).toHaveCount(0);
    await expect(app.dock).toContainText(app.t('lock.generated'));
    await expect(app.dock).toContainText(app.t('strength.4'));

    await app.dock.getByRole('button', { name: app.t('lock.copy'), exact: true }).click();
    await app.expectToast('toast.passwordCopied');
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(generated);

    // Generating again gives another one.
    await app.dock.getByRole('button', { name: app.t('lock.generate'), exact: true }).click();
    const second = await app.lockPassword.inputValue();
    expect(second).not.toBe(generated);

    const saved = await lockAndSave(app, source.file);
    expect(saved.name).toBe(lockedName(source.file));
    // After locking the password is still there to be copied.
    const kept = app.dock.getByLabel(app.t('lock.password.label'), { exact: true });
    await expect(kept).toHaveValue(second);
    await page.evaluate(() => navigator.clipboard.writeText(''));
    await app.dock.getByRole('button', { name: app.t('lock.copy'), exact: true }).click();
    await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(second);

    expect(await inspectPdf(saved.bytes, generated)).toMatchObject({ access: 'locked' });
    expect(await inspectPdf(saved.bytes, second)).toMatchObject({
      access: 'both',
      pageCount: source.pageCount,
    });
  });

  test('AES-128 for old readers, with unencrypted metadata', async ({ app }) => {
    const source = fixture('objstm-plain.pdf');
    await startLocking(app, source.file);
    await app.openAdvanced();

    const aes128 = app.dock.getByRole('radio', { name: /AES-128/ });
    await aes128.check();
    await expect(aes128).toBeChecked();
    await expect(app.advancedToggle).toContainText('AES-128');

    // AES-128 cannot encode Chinese: said at the field before anything runs.
    await app.lockPassword.fill('密码');
    await app.lockConfirmation.fill('密码');
    await app.lockConfirmation.press('Enter');
    await expect(app.dock.getByRole('alert')).toHaveText(app.t('lock.error.notEncodable.aes-128'));
    // The app puts the cursor into the field that has to change (a moment after the refusal;
    // typing into another field before that would be typing into this one).
    await expect(app.lockPassword).toBeFocused();
    await app.expectState(source.file, 'ready', 'lock');

    // …and is limited to 32 characters.
    const tooLong = 'x'.repeat(33);
    await app.lockPassword.fill(tooLong);
    await app.lockConfirmation.fill(tooLong);
    await app.lockConfirmation.press('Enter');
    await expect(app.dock.getByRole('alert')).toHaveText(app.t('lock.error.tooLong.aes-128'));
    await expect(app.lockPassword).toBeFocused();

    const password = 'old-reader-128';
    await app.lockPassword.fill(password);
    await app.lockConfirmation.fill(password);
    await app.switch('lock.metadata.switch', app.dock).click();
    await expect(app.switch('lock.metadata.switch', app.dock)).not.toBeChecked();

    const saved = await lockAndSave(app, source.file);
    await expect(app.card(source.file)).toContainText('AES-128');
    expect(await inspectPdf(saved.bytes, password)).toMatchObject({
      access: 'both',
      pageCount: source.pageCount,
      encryption: {
        algorithm: 'aes-128',
        keyBits: 128,
        revision: 4,
        encryptMetadata: false,
        permissions: EVERYTHING_ALLOWED,
      },
    });
  });

  test('a permissions password with restrictions: the copy reports exactly those', async ({
    app,
  }) => {
    const source = fixture('plain.pdf');
    const openPassword = 'open-sesame-42';
    const ownerPassword = 'owner-only-knows';
    await startLocking(app, source.file);
    await app.lockPassword.fill(openPassword);
    await app.lockConfirmation.fill(openPassword);
    await app.openAdvanced();

    const separate = app.switch('lock.owner.switch', app.dock);
    await separate.click();
    await expect(separate).toBeChecked();
    await expect(app.ownerPassword).toBeFocused();

    // The permissions password must differ from the open password.
    await app.ownerPassword.fill(openPassword);
    await app.ownerPassword.press('Enter');
    await expect(app.dock.getByRole('alert')).toHaveText(app.t('lock.error.ownerSame'));
    await app.expectState(source.file, 'ready', 'lock');
    await app.ownerPassword.fill(ownerPassword);
    await expect(app.dock.getByRole('alert')).toHaveCount(0);

    // Printing: low resolution only. Copying: off. Everything else stays allowed.
    const printing = app.dock.getByRole('radiogroup', { name: app.t('lock.permission.print') });
    await printing.getByRole('radio', { name: app.t('lock.print.low'), exact: true }).click();
    await expect(
      printing.getByRole('radio', { name: app.t('lock.print.low'), exact: true }),
    ).toBeChecked();
    const copying = app.switch('lock.permission.extract', app.dock);
    await expect(copying).toBeChecked();
    await copying.click();
    await expect(copying).not.toBeChecked();
    await expect(app.advancedToggle).toContainText(app.listed('lock.summary.restricted'));

    const saved = await lockAndSave(app, source.file);
    const expected: Permissions = { ...EVERYTHING_ALLOWED, print: 'low', extract: false };
    expect(await inspectPdf(saved.bytes, openPassword)).toMatchObject({
      access: 'user',
      encryption: { algorithm: 'aes-256', permissions: expected },
    });
    expect(await inspectPdf(saved.bytes, ownerPassword)).toMatchObject({ access: 'owner' });

    // The details of the copy, as the app shows them.
    await app.startOver();
    await app.switchMode('unlock');
    await app.addFiles([saved.path]);
    await app.expectState(saved.name, 'needs-password');
    const details = await app.openDetails(saved.name);
    await expect(details).toContainText(app.t('details.protection.password'));
    const rows = details.getByRole('listitem');
    await expect(rows).toHaveCount(7);
    const row = (label: Parameters<App['t']>[0]) => rows.filter({ hasText: app.t(label) });
    await expect(row('permission.print')).toContainText(app.t('permission.lowResolution'));
    await expect(row('permission.extract')).toContainText(app.t('permission.denied'));
    for (const allowed of [
      'permission.modify',
      'permission.annotate',
      'permission.fillForms',
      'permission.assemble',
      'permission.accessibility',
    ] as const) {
      await expect(row(allowed)).toContainText(app.t('permission.allowed'));
    }
    await expect(rows.filter({ hasText: app.t('permission.denied') })).toHaveCount(1);
    await expect(rows.filter({ hasText: app.t('permission.lowResolution') })).toHaveCount(1);
  });

  test('restrictions without an open password: anyone can open, nobody can print', async ({
    app,
  }) => {
    const source = fixture('plain.pdf');
    await startLocking(app, source.file);
    await app.openAdvanced();
    await app.switch('lock.owner.switch', app.dock).click();
    await app.ownerPassword.fill('only-the-owner');
    // The open password may now stay empty, and the form says so.
    await expect(app.dock).toContainText(app.t('lock.password.openOptional'));
    const printing = app.dock.getByRole('radiogroup', { name: app.t('lock.permission.print') });
    await printing.getByRole('radio', { name: app.t('lock.print.none'), exact: true }).click();
    await app.switch('lock.permission.modify', app.dock).click();

    const saved = await lockAndSave(app, source.file);
    await expect(app.dock).toContainText(app.t('lock.result.noPassword'));
    expect(await inspectPdf(saved.bytes)).toMatchObject({
      encrypted: true,
      access: 'user',
      opensWithoutPassword: true,
      pageCount: source.pageCount,
      encryption: { permissions: { ...EVERYTHING_ALLOWED, print: 'none', modify: false } },
    });

    // Unlock mode sees a file that only carries restrictions, and says which.
    await app.startOver();
    await app.switchMode('unlock');
    await app.addFiles([saved.path]);
    await app.expectState(saved.name, 'restricted');
    await expect(app.card(saved.name)).toContainText(app.listed('restriction.print'));
    await expect(app.card(saved.name)).toContainText(app.listed('restriction.modify'));
    await expect(app.dockButton('action.removeRestrictions')).toBeVisible();
  });
});

test.describe('one password for every result in the list', () => {
  const FIRST = 'first-password-11';
  const SECOND = 'second-password-22';

  /** The read-only field of the result panel: the password the results were made with. */
  function appliedPassword(app: App) {
    return app.page.locator('#lock-result-password');
  }

  async function fillForm(app: App, password: string): Promise<void> {
    await app.lockPassword.fill(password);
    await app.lockConfirmation.fill(password);
  }

  /** Every entry of the saved ZIP opens with `password` and not with `other`. */
  async function expectAllOpenWith(
    saved: SavedFile,
    names: string[],
    password: string,
    other: string,
  ) {
    const entries = readZip(saved.bytes);
    expect(entries.map((entry) => entry.name)).toEqual(names);
    for (const entry of entries) {
      expect(await inspectPdf(entry.data, password), entry.name).toMatchObject({ access: 'both' });
      expect(await inspectPdf(entry.data, other), entry.name).toMatchObject({ access: 'locked' });
    }
  }

  test('a file added after a run, with another password: the finished file is locked again', async ({
    app,
  }) => {
    await startLocking(app, 'plain.pdf');
    await fillForm(app, FIRST);
    await app.lockConfirmation.press('Enter');
    await app.expectState('plain.pdf', 'done', 'lock');
    await expect(appliedPassword(app)).toHaveValue(FIRST);

    // The form comes back with what was used; as it stands only the new file would be locked.
    await app.addFixtures('objstm-plain.pdf');
    await app.expectState('objstm-plain.pdf', 'ready', 'lock');
    await expect(app.lockPassword).toHaveValue(FIRST);
    await expect(app.dockButton('action.lock')).toBeVisible();

    // Another password concerns the finished file too, and the button says so.
    await fillForm(app, SECOND);
    await expect(app.dockButton('action.lockCount', { count: 2 })).toBeVisible();
    await expect(app.page.locator('.listhead__summary')).toContainText(
      app.t('list.summary.relock', { count: 1 }),
    );
    await app.press(app.dockButton('action.lockCount', { count: 2 }));
    await app.expectState('plain.pdf', 'done', 'lock');
    await app.expectState('objstm-plain.pdf', 'done', 'lock');
    await expect(app.dock).toContainText(app.t('status.locked', { count: 2 }));

    // One password is shown, and it opens both files.
    await expect(appliedPassword(app)).toHaveValue(SECOND);
    await expectAllOpenWith(
      await app.saveAll(),
      ['plain_locked.pdf', 'objstm-plain_locked.pdf'],
      SECOND,
      FIRST,
    );
  });

  test('a file added after a run, same password: the finished file is left alone', async ({
    app,
  }) => {
    await startLocking(app, 'plain.pdf');
    await fillForm(app, FIRST);
    await app.lockConfirmation.press('Enter');
    await app.expectState('plain.pdf', 'done', 'lock');
    await app.saveAll();
    await expect(app.card('plain.pdf')).toContainText(app.t('entry.saved'));

    await app.addFixtures('objstm-plain.pdf');
    await app.expectState('objstm-plain.pdf', 'ready', 'lock');
    await app.press(app.dockButton('action.lock'));
    await app.expectState('objstm-plain.pdf', 'done', 'lock');
    // Still the result that was saved: it was not made again.
    await expect(app.card('plain.pdf')).toContainText(app.t('entry.saved'));
    await expect(appliedPassword(app)).toHaveValue(FIRST);
    await expectAllOpenWith(
      await app.saveAll(),
      ['plain_locked.pdf', 'objstm-plain_locked.pdf'],
      FIRST,
      SECOND,
    );
  });

  test('a protected file that waited for its current password, another password meanwhile', async ({
    app,
  }) => {
    const waiting = fixture('aes-256-r6.pdf');
    await startLocking(app, 'plain.pdf', waiting.file);
    await fillForm(app, FIRST);
    await app.lockConfirmation.press('Enter');
    await app.expectState('plain.pdf', 'done', 'lock');
    await app.expectState(waiting.file, 'encrypted', 'lock');

    await fillForm(app, SECOND);
    await app.cardField(waiting.file).fill(waiting.userPassword!);
    await app.press(app.dockButton('action.lockCount', { count: 2 }));
    await app.expectState('plain.pdf', 'done', 'lock');
    await app.expectState(waiting.file, 'done', 'lock');

    await expect(appliedPassword(app)).toHaveValue(SECOND);
    await expectAllOpenWith(
      await app.saveAll(),
      ['plain_locked.pdf', lockedName(waiting.file)],
      SECOND,
      FIRST,
    );
  });

  test('removing every file by hand leaves no password behind', async ({ app }) => {
    await startLocking(app, 'plain.pdf', 'objstm-plain.pdf');
    await app.dock.getByRole('button', { name: app.t('lock.generate'), exact: true }).click();
    const generated = await app.lockPassword.inputValue();
    await app.press(app.dockButton('action.lockCount', { count: 2 }));
    await app.expectState('objstm-plain.pdf', 'done', 'lock');
    await expect(appliedPassword(app)).toHaveValue(generated);

    await app.menuCommand('plain.pdf', 'entry.menu.remove');
    await app.menuCommand('objstm-plain.pdf', 'entry.menu.remove');
    await expect(app.chooseButton).toBeVisible();

    // The next file meets an empty form, hidden again, that asks for a confirmation.
    await app.addFixtures('crlf-plain.pdf');
    await app.expectState('crlf-plain.pdf', 'ready', 'lock');
    await expect(app.lockPassword).toHaveValue('');
    await expect(app.lockPassword).toHaveAttribute('type', 'password');
    await expect(app.lockConfirmation).toHaveValue('');
    expect(await app.page.content()).not.toContain(generated);
  });
});

test.describe('lock a file that is already protected', () => {
  test('asks for the current password on the card and replaces the protection', async ({ app }) => {
    const source = fixture('aes-128-r4.pdf');
    const newPassword = 'brand-new-password-9';
    await startLocking(app, source.file);

    await app.expectState(source.file, 'encrypted', 'lock');
    await expect(app.card(source.file)).toContainText('AES-128');
    await expect(app.card(source.file)).toContainText(app.t('entry.note.willReplace'));
    await expect(app.card(source.file)).toContainText(app.t('entry.note.needsCurrentPassword'));
    await expect(app.cardField(source.file)).toBeVisible();
    // Nothing can be locked before the card has its password.
    await expect(app.dock).toContainText(app.t('status.nothingToLock'));

    await app.lockPassword.fill(newPassword);
    await app.lockConfirmation.fill(newPassword);

    // Without the current password: asked for, on the card.
    await app.dockButton('action.lock').click({ force: true });
    await expect(app.card(source.file).getByRole('alert')).toHaveText(
      app.t('entry.currentPassword.required'),
    );
    await expect(app.cardField(source.file)).toBeFocused();

    // A wrong current password: rejected on the card.
    await app.cardField(source.file).fill(source.wrongPassword);
    await expect(app.dock).toContainText(app.t('lock.warning'));
    await app.press(app.dockButton('action.lock'));
    await app.expectState(source.file, 'wrong-password', 'lock');
    await expect(app.card(source.file).getByRole('alert')).toHaveText(
      app.t('entry.currentPassword.wrong'),
    );

    // The right one: the protection is replaced.
    await app.cardField(source.file).fill(source.userPassword!);
    await app.press(app.dockButton('action.lock'));
    await app.expectState(source.file, 'done', 'lock');
    await expect(app.card(source.file)).toContainText('AES-256');

    const saved = await app.saveAll();
    expect(saved.name).toBe(lockedName(source.file));
    expect(await inspectPdf(saved.bytes, source.userPassword!)).toMatchObject({ access: 'locked' });
    expect(await inspectPdf(saved.bytes, newPassword)).toMatchObject({
      access: 'both',
      pageCount: source.pageCount,
      encryption: { algorithm: 'aes-256', keyBits: 256, permissions: EVERYTHING_ALLOWED },
    });
  });

  test('a file that only carries restrictions is re-locked without asking', async ({ app }) => {
    const source = fixture('owner-only-r4.pdf');
    const password = 'now-with-a-password';
    await startLocking(app, source.file);
    await app.expectState(source.file, 'encrypted', 'lock');
    await expect(app.cardField(source.file)).toHaveCount(0);

    await app.lockPassword.fill(password);
    await app.lockConfirmation.fill(password);
    const saved = await lockAndSave(app, source.file);
    expect(await inspectPdf(saved.bytes)).toMatchObject({ access: 'locked' });
    expect(await inspectPdf(saved.bytes, password)).toMatchObject({
      access: 'both',
      pageCount: source.pageCount,
      encryption: { algorithm: 'aes-256', permissions: EVERYTHING_ALLOWED },
    });
  });

  test('several files: plain ones are locked, protected ones wait for their password', async ({
    app,
  }) => {
    const password = 'batch-lock-password';
    await startLocking(app, 'plain.pdf', 'objstm-plain.pdf', 'aes-256-r6.pdf');
    await expect(app.dockButton('action.lockCount', { count: 2 })).toBeVisible();
    await expect(app.page.locator('.listhead__summary')).toContainText(
      app.t('list.summary.needCurrent', { count: 1 }),
    );

    await app.lockPassword.fill(password);
    await app.lockConfirmation.fill(password);
    await app.lockConfirmation.press('Enter');
    await app.expectState('plain.pdf', 'done', 'lock');
    await app.expectState('objstm-plain.pdf', 'done', 'lock');
    await app.expectState('aes-256-r6.pdf', 'encrypted', 'lock');
    await expect(app.cardField('aes-256-r6.pdf')).toBeVisible();

    // The third one joins once its current password is there.
    await app.cardField('aes-256-r6.pdf').fill('user');
    await app.press(app.dockButton('action.lock'));
    await app.expectState('aes-256-r6.pdf', 'done', 'lock');
    await expect(app.dock).toContainText(app.t('status.locked', { count: 3 }));
  });
});
