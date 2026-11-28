/**
 * Unlock mode with several files: one password for every file that needs one, the files it does
 * not open are retried on their own, and the results leave as one ZIP.
 */
import { readFileSync } from 'node:fs';
import { expect, test, type App } from './support/app';
import { LARGE_PDF, fixture, fixturePath, unlockedName } from './support/files';
import { expectUnlockedCopy } from './support/pdf';
import { readZip } from './support/zip';

/** The line under the list header: "2 need a password · 1 is restricted · …". */
function summaryLine(app: App) {
  return app.page.locator('.listhead__summary');
}

test.describe('unlock several files', () => {
  test('five mixed files: one password, one retry, one ZIP', async ({ app }) => {
    const first = fixture('aes-256-r6.pdf'); // password "user"
    const second = fixture('unicode-saslprep-r6.pdf'); // a Unicode password
    const restricted = fixture('owner-only-r6.pdf');
    const plain = fixture('plain.pdf');
    const damaged = 'damaged-unrecoverable.pdf';

    await app.open();
    await app.addFixtures(first.file, second.file, restricted.file, plain.file, damaged);
    await app.analysed(5);

    // Every file says what it is.
    await app.expectState(first.file, 'needs-password');
    await app.expectState(second.file, 'needs-password');
    await app.expectState(restricted.file, 'restricted');
    await app.expectState(plain.file, 'not-encrypted');
    await app.expectState(damaged, 'error');
    await expect(app.card(damaged)).toContainText(app.t('error.damaged.title'));
    await expect(app.card(damaged)).toContainText(app.t('error.damaged.advice'));

    // The technical details of the failure are one tap away, not in the way.
    const disclosure = app
      .card(damaged)
      .getByRole('button', { name: app.t('entry.error.details'), exact: true });
    await expect(disclosure).toHaveAttribute('aria-expanded', 'false');
    await disclosure.click();
    await expect(disclosure).toHaveAttribute('aria-expanded', 'true');
    await expect(app.card(damaged).locator('pre')).not.toBeEmpty();

    // The header counts, the summary line explains, the button says how many it will process.
    await expect(app.page.getByRole('heading', { level: 2 }).first()).toContainText(
      app.t('format.files', { count: 5 }),
    );
    await expect(summaryLine(app)).toContainText(app.t('list.summary.failed', { count: 1 }));
    await expect(summaryLine(app)).toContainText(app.t('list.summary.needPassword', { count: 2 }));
    await expect(summaryLine(app)).toContainText(app.t('list.summary.restricted', { count: 1 }));
    await expect(summaryLine(app)).toContainText(app.t('list.summary.notEncrypted', { count: 1 }));
    await expect(app.dockButton('action.unlockCount', { count: 3 })).toBeVisible();
    await expect(app.dock).toContainText(app.t('unlock.password.sharedHint'));

    // One password: it opens the first file; the restricted one needs none; the second refuses.
    await app.unlockWith(first.userPassword!);
    await app.expectState(first.file, 'done');
    await app.expectState(restricted.file, 'done');
    await app.expectState(second.file, 'wrong-password');
    await app.expectState(plain.file, 'not-encrypted');
    await app.expectState(damaged, 'error');
    await expect(summaryLine(app)).toContainText(app.t('list.summary.rejected', { count: 1 }));
    await expect(summaryLine(app)).toContainText(app.t('list.summary.done', { count: 2 }));
    await expect(summaryLine(app)).not.toContainText(
      app.t('list.summary.needPassword', { count: 1 }),
    );

    // One file is left: the shared field takes its password, the button counts one.
    await expect(app.unlockField).toHaveValue('');
    await expect(app.cardField(second.file)).toHaveCount(0);
    await expect(app.dockButton('action.unlock')).toBeVisible();

    // Its own result can be saved from its card meanwhile.
    const single = await app.download(() =>
      app
        .card(first.file)
        .getByRole('button', { name: app.t('entry.save'), exact: true })
        .click(),
    );
    expect(single.name).toBe(unlockedName(first.file));
    await expectUnlockedCopy(single.bytes, first);
    await expect(app.card(first.file)).toContainText(app.t('entry.saved'));

    await app.unlockWith(second.userPassword!);
    await app.expectState(second.file, 'done');

    // Finished: three results, one file that could not be processed.
    await expect(app.dock).toContainText(app.t('status.unlocked', { count: 3 }));
    await expect(app.dock).toContainText(app.t('status.failed', { count: 1 }));
    await expect(summaryLine(app)).toContainText(app.t('list.summary.done', { count: 3 }));

    const archive = await app.saveAll();
    expect(archive.name).toBe(`${app.t('zip.unlocked')}.zip`);
    await app.expectToast('toast.downloaded');
    const entries = readZip(archive.bytes);
    expect(entries.map((entry) => entry.name)).toEqual([
      unlockedName(first.file),
      unlockedName(second.file),
      unlockedName(restricted.file),
    ]);
    await expectUnlockedCopy(entries[0]!.data, first);
    await expectUnlockedCopy(entries[1]!.data, second);
    await expectUnlockedCopy(entries[2]!.data, restricted);
    // Every result counts as saved now.
    for (const file of [first.file, second.file, restricted.file]) {
      await expect(app.card(file)).toContainText(app.t('entry.saved'));
    }
  });

  test('files the shared password does not open are retried on their own cards', async ({
    app,
  }) => {
    const opened = fixture('rc4-128-r3.pdf'); // "user"
    const chinese = fixture('gbk-r3.pdf'); // "中文密码"
    const unicode = fixture('unicode-raw-r6.pdf');
    const latin = fixture('latin1-r4.pdf'); // "Pässwörd"

    await app.open();
    await app.addFixtures(opened.file, chinese.file, unicode.file, latin.file);
    await app.analysed(4);
    await expect(app.dockButton('action.unlockCount', { count: 4 })).toBeVisible();

    await app.unlockWith(opened.userPassword!);
    await app.expectState(opened.file, 'done');
    for (const file of [chinese.file, unicode.file, latin.file]) {
      await app.expectState(file, 'wrong-password');
      await expect(app.cardField(file)).toBeVisible();
    }
    await expect(summaryLine(app)).toContainText(app.t('list.summary.rejected', { count: 3 }));
    await expect(app.dockButton('action.unlockCount', { count: 3 })).toBeVisible();
    // The focus is on the first card that needs a password.
    await expect(app.cardField(chinese.file)).toBeFocused();

    // The summary's "wrong password" jumps to the first file it is about.
    await app.unlockField.focus();
    await summaryLine(app)
      .getByRole('button', {
        name: app.t('aria.jumpTo', { label: app.t('list.summary.rejected', { count: 3 }) }),
      })
      .click();
    await expect(app.cardField(chinese.file)).toBeFocused();

    // A wrong password on a card stays on that card.
    await app.cardField(chinese.file).fill('not this one');
    await app.cardField(chinese.file).press('Enter');
    await expect(app.cardField(chinese.file)).toHaveAttribute('aria-invalid', 'true');
    await app.expectState(chinese.file, 'wrong-password');
    await expect(app.cardField(chinese.file)).toBeFocused();
    await app.expectState(unicode.file, 'wrong-password');

    // The right one opens just this file (Enter in the card's field).
    await app.cardField(chinese.file).fill(chinese.userPassword!);
    await app.cardField(chinese.file).press('Enter');
    await app.expectState(chinese.file, 'done');
    await app.expectState(unicode.file, 'wrong-password');
    await app.expectState(latin.file, 'wrong-password');

    // The card's own button does the same.
    await app.cardField(unicode.file).fill(unicode.userPassword!);
    await app
      .card(unicode.file)
      .getByRole('button', { name: app.t('entry.password.submit'), exact: true })
      .click();
    await app.expectState(unicode.file, 'done');

    // The last one keeps its own field; the shared one opens it just as well.
    await expect(app.cardField(latin.file)).toBeVisible();
    await app.unlockWith(latin.userPassword!);
    await app.expectState(latin.file, 'done');
    await expect(app.dock).toContainText(app.t('status.unlocked', { count: 4 }));

    const entries = readZip((await app.saveAll()).bytes);
    expect(entries.map((entry) => entry.name)).toEqual(
      [opened, chinese, unicode, latin].map((source) => unlockedName(source.file)),
    );
    for (const [index, source] of [opened, chinese, unicode, latin].entries()) {
      await expectUnlockedCopy(entries[index]!.data, source);
    }
  });

  test('a card keeps its field, and what was typed into it, while another card is retried', async ({
    app,
    page,
  }) => {
    // A large file, so that its retry takes long enough to be looked at.
    test.setTimeout(90_000);
    const small = fixture('aes-256-r6.pdf');
    await app.open();
    await app.addFiles([LARGE_PDF.path, fixturePath(small.file)]);
    await app.analysed(2);
    await app.unlockWith('opens neither');
    await app.expectState(LARGE_PDF.name, 'wrong-password');
    await app.expectState(small.file, 'wrong-password');

    // Typed into the second card, not sent yet.
    await app.cardField(small.file).fill(small.userPassword!);

    // From here on every change of the list is looked at: the second card must not lose its
    // field or its text, and must not change its height, whatever the first card does.
    const cardId = (await app.card(small.file).getAttribute('data-entry'))!;
    await page.evaluate(
      ({ id, typed }) => {
        const card = document.querySelector<HTMLElement>(`[data-entry="${id}"]`)!;
        const seen = { heights: [] as number[], lost: 0 };
        const look = (): void => {
          const height = Math.round(card.getBoundingClientRect().height);
          if (!seen.heights.includes(height)) seen.heights.push(height);
          const field = card.querySelector<HTMLInputElement>('[data-inline-password]');
          if (!card.isConnected || field?.value !== typed) seen.lost++;
        };
        look();
        new MutationObserver(look).observe(document.body, {
          subtree: true,
          childList: true,
          attributes: true,
          characterData: true,
        });
        (window as unknown as { e2eSibling: typeof seen }).e2eSibling = seen;
      },
      { id: cardId, typed: small.userPassword! },
    );

    // The first card's retry fails …
    await app.cardField(LARGE_PDF.name).fill('still wrong');
    await app.cardField(LARGE_PDF.name).press('Enter');
    await expect(app.cardField(LARGE_PDF.name)).toHaveAttribute('aria-invalid', 'true');
    await expect(app.cardField(LARGE_PDF.name)).toBeFocused();
    await expect(app.cardField(small.file)).toHaveValue(small.userPassword!);

    // … and then works, which takes a moment.
    await app.cardField(LARGE_PDF.name).fill(LARGE_PDF.password);
    await app.cardField(LARGE_PDF.name).press('Enter');
    await app.expectState(LARGE_PDF.name, 'done');

    const seen = await page.evaluate(
      () => (window as unknown as { e2eSibling: { heights: number[]; lost: number } }).e2eSibling,
    );
    expect(seen.lost, 'renders in which the second card had lost its field or its text').toBe(0);
    expect(seen.heights, 'heights of the second card along the way').toHaveLength(1);

    // It is the only locked file now and still has its own field, with the password in it.
    await app.expectState(small.file, 'wrong-password');
    await expect(app.cardField(small.file)).toHaveValue(small.userPassword!);
    await app.cardField(small.file).press('Enter');
    await app.expectState(small.file, 'done');
    await expect(app.dock).toContainText(app.t('status.unlocked', { count: 2 }));
  });

  test('a password that opens nothing is rejected at the shared field', async ({ app }) => {
    await app.open();
    await app.addFixtures('aes-256-r6.pdf', 'aes-128-r4.pdf');
    await app.analysed(2);

    await app.unlockWith('nobody-uses-this');
    await expect(app.dock).toContainText(app.t('unlock.password.wrong'));
    await expect(app.unlockField).toBeFocused();
    await expect(app.unlockField).toHaveAttribute('aria-invalid', 'true');
    await app.expectState('aes-256-r6.pdf', 'wrong-password');
    await app.expectState('aes-128-r4.pdf', 'wrong-password');

    await app.unlockWith('user');
    await app.expectState('aes-256-r6.pdf', 'done');
    await app.expectState('aes-128-r4.pdf', 'done');
    await expect(app.dock).toContainText(app.t('status.unlocked', { count: 2 }));
  });

  test('two files of the same name get distinct output names', async ({ app }) => {
    const sources = [fixture('aes-256-r6.pdf'), fixture('aes-128-r4.pdf')];
    await app.open();
    // Same name, different folders: only their content tells them apart.
    const chooser = app.page.waitForEvent('filechooser');
    await app.chooseButton.click();
    await (
      await chooser
    ).setFiles(
      sources.map((source) => ({
        name: 'statement.pdf',
        mimeType: 'application/pdf',
        buffer: readFileSync(fixturePath(source.file)),
      })),
    );
    await app.analysed(2);

    await app.unlockWith('user');
    await expect(app.dock).toContainText(app.t('status.unlocked', { count: 2 }));
    const entries = readZip((await app.saveAll()).bytes);
    expect(entries.map((entry) => entry.name)).toEqual([
      'statement_unlocked.pdf',
      'statement_unlocked (2).pdf',
    ]);
    await expectUnlockedCopy(entries[0]!.data, sources[0]!);
    await expectUnlockedCopy(entries[1]!.data, sources[1]!);
  });

  test('a finished file can be processed again or removed from its menu', async ({ app }) => {
    await app.open();
    await app.addFixtures('owner-only-r6.pdf', 'owner-only-r4.pdf');
    await app.analysed(2);
    await app.press(app.dockButton('action.removeRestrictionsCount', { count: 2 }));
    await expect(app.dock).toContainText(app.t('status.unlocked', { count: 2 }));

    // "Process again" discards the result of one file.
    await app.menuCommand('owner-only-r4.pdf', 'entry.menu.redo');
    await app.expectState('owner-only-r4.pdf', 'restricted');
    await app.expectState('owner-only-r6.pdf', 'done');
    await expect(app.dockButton('action.removeRestrictions')).toBeVisible();

    // "Remove" takes the other one out of the list.
    await app.menuCommand('owner-only-r6.pdf', 'entry.menu.remove');
    await expect(app.cards).toHaveCount(1);
    await expect(app.card('owner-only-r6.pdf')).toHaveCount(0);
  });
});
