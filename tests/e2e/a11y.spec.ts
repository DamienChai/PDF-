/**
 * Accessibility: axe-core on every main state, in the light and in the dark theme. No rule is
 * switched off; a state passes when axe finds nothing it rates serious or critical. What it rates
 * moderate or minor is attached to the test as an annotation, for the report.
 */
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type App } from './support/app';

async function audit(app: App, state: string): Promise<void> {
  const { page } = app;
  for (const theme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: theme });
    await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
    // Not while anything is still fading in: axe must not measure a half-faded colour.
    await app.settled();
    const { violations } = await new AxeBuilder({ page }).analyze();
    const describe = (violation: (typeof violations)[number]): string =>
      [
        `${violation.id} (${violation.impact}): ${violation.help}`,
        ...violation.nodes.map(
          (node) =>
            `    ${node.target.join(' ')}\n      ${node.failureSummary?.replace(/\n/g, '\n      ')}`,
        ),
      ].join('\n');
    const blocking = violations.filter(
      (violation) => violation.impact === 'serious' || violation.impact === 'critical',
    );
    for (const violation of violations) {
      if (blocking.includes(violation)) continue;
      test.info().annotations.push({
        type: `axe ${violation.impact}`,
        description: `${state}, ${theme}: ${violation.id} — ${violation.help} (${violation.nodes.length}×)`,
      });
    }
    expect(blocking.map(describe), `${state}, ${theme} theme`).toEqual([]);
  }
}

test.describe('accessibility (axe)', () => {
  test('empty state, in both modes', async ({ app }) => {
    await app.open();
    await audit(app, 'empty, unlock');
    await app.switchMode('lock');
    await audit(app, 'empty, lock');
  });

  test('unlocking one file: password, wrong password, result', async ({ app }) => {
    await app.open();
    await app.addFixtures('rc4-40-r2.pdf');
    await app.expectState('rc4-40-r2.pdf', 'needs-password');
    await audit(app, 'one file needs a password');

    await app.unlockWith('wrong');
    await app.expectState('rc4-40-r2.pdf', 'wrong-password');
    await audit(app, 'wrong password');

    await app.unlockWith('user');
    await app.expectState('rc4-40-r2.pdf', 'done');
    await audit(app, 'unlocked');

    await app.saveAll();
    await app.expectToast('toast.downloaded');
    await audit(app, 'saved, with a toast');
  });

  test('a list with every kind of card', async ({ app }) => {
    await app.open();
    await app.addFixtures(
      'aes-256-r6.pdf',
      'unicode-saslprep-r6.pdf',
      'gbk-r3.pdf',
      'owner-only-r6.pdf',
      'plain.pdf',
      'damaged-unrecoverable.pdf',
      'damaged-recoverable.pdf',
    );
    await app.analysed(7);
    await audit(app, 'mixed list');

    await app.unlockWith('user');
    await app.expectState('aes-256-r6.pdf', 'done');
    await app.expectState('gbk-r3.pdf', 'wrong-password');
    await app
      .card('damaged-unrecoverable.pdf')
      .getByRole('button', { name: app.t('entry.error.details'), exact: true })
      .click();
    await audit(app, 'list with results, retry fields and an error');

    await app.switchMode('lock');
    await app.analysed(7);
    await audit(app, 'the same list in lock mode');
  });

  test('restrictions only, and nothing to unlock', async ({ app }) => {
    await app.open();
    await app.addFixtures('owner-only-r6.pdf');
    await app.expectState('owner-only-r6.pdf', 'restricted');
    await audit(app, 'restrictions only');
    await app.clear();
    await app.addFixtures('plain.pdf');
    await app.expectState('plain.pdf', 'not-encrypted');
    await audit(app, 'nothing to unlock');
  });

  test('lock form: empty, with errors, with every option, and the result', async ({ app }) => {
    await app.open();
    await app.switchMode('lock');
    await app.addFixtures('plain.pdf', 'aes-128-r4.pdf');
    await app.analysed(2);
    await audit(app, 'lock form');

    await app.lockPassword.fill('1234');
    await app.lockConfirmation.fill('12345');
    await app.lockConfirmation.press('Enter');
    await expect(app.dock.getByRole('alert')).toHaveText(app.t('lock.error.mismatch'));
    await audit(app, 'lock form with a weak password and an error');

    await app.dock.getByRole('button', { name: app.t('lock.generate'), exact: true }).click();
    await app.openAdvanced();
    await app.switch('lock.owner.switch', app.dock).click();
    await app.ownerPassword.fill('owner-password');
    await app.switch('lock.permission.extract', app.dock).click();
    await audit(app, 'lock form with a generated password and all options');

    await app.cardField('aes-128-r4.pdf').fill('wrong');
    await app.press(app.dockButton('action.lockCount', { count: 2 }));
    await app.expectState('plain.pdf', 'done', 'lock');
    await app.expectState('aes-128-r4.pdf', 'wrong-password', 'lock');
    await audit(app, 'locked, one current password rejected');
  });

  test('settings, details and the file menu', async ({ app, page }) => {
    await app.open();
    await app.addFixtures('rc4-40-r2.pdf', 'plain.pdf');
    await app.analysed(2);

    const settings = await app.openSettings();
    await audit(app, 'settings');
    await settings.getByText(app.t('about.licenses'), { exact: true }).click();
    await audit(app, 'settings with the licences open');
    await app.closeDialog();

    await app.menuButton('rc4-40-r2.pdf').click();
    await expect(page.getByRole('menu')).toBeVisible();
    await audit(app, 'file menu');
    await app.menuItem('entry.menu.details').click();
    await expect(app.dialog.filter({ hasText: app.t('details.title') })).toBeVisible();
    await expect(app.dialog).toHaveCount(1);
    await audit(app, 'details of an RC4 file');
    await app.closeDialog();

    await app.unlockWith('user');
    await app.expectState('rc4-40-r2.pdf', 'done');
    await app.openDetails('rc4-40-r2.pdf');
    await audit(app, 'details with a result');
  });
});

test.describe('what a screen reader is given', () => {
  test('the names and descriptions of controls are the messages themselves', async ({
    app,
    page,
    context,
    browserName,
  }) => {
    test.skip(browserName !== 'chromium', 'the accessibility tree is read through DevTools');
    await app.open();
    await app.switchMode('lock');
    await app.addFixtures('plain.pdf');
    await app.expectState('plain.pdf', 'ready', 'lock');
    await app.openAdvanced();

    const devtools = await context.newCDPSession(page);
    const { nodes } = (await devtools.send('Accessibility.getFullAXTree')) as {
      nodes: {
        ignored: boolean;
        role?: { value: string };
        name?: { value: string };
        description?: { value: string };
      }[];
    };
    const controls = nodes.filter((node) => !node.ignored);
    // (A no-break space inside a clause is the space of the message.)
    const spaces = (text: string | undefined): string => (text ?? '').replaceAll('\u00a0', ' ');
    const described = (role: string, name: string): string =>
      spaces(
        controls.find((node) => node.role?.value === role && node.name?.value === name)?.description
          ?.value,
      );
    // The end of an explanation is set as one piece (prose.tsx). In Chinese nothing separates
    // it from the text before it, and nothing may: no space inside a sentence or a word.
    expect(described('switch', app.t('lock.metadata.switch'))).toBe(
      app.t('lock.metadata.description'),
    );
    expect(described('switch', app.t('lock.owner.switch'))).toBe(app.t('lock.owner.description'));
    const radios = controls
      .filter((node) => node.role?.value === 'radio')
      .map((node) => spaces(node.name?.value));
    for (const key of [
      'lock.algorithm.aes-256.description',
      'lock.algorithm.aes-128.description',
    ] as const) {
      expect(radios.filter((name) => name.endsWith(app.t(key)))).toHaveLength(1);
    }
  });
});
