/**
 * Sheets, dialogs and the file menu: how they close (Escape, the scrim, the close button, the
 * Android back gesture, dragging down), where the focus is while they are open, and where it
 * goes afterwards.
 */
import type { Locator, Page } from '@playwright/test';
import { expect, test } from './support/app';

/** The element that has the focus is inside `container`. */
async function expectFocusWithin(container: Locator): Promise<void> {
  await expect
    .poll(() => container.evaluate((element) => element.contains(document.activeElement)))
    .toBe(true);
}

function historyLength(page: Page): Promise<number> {
  return page.evaluate(() => history.length);
}

test.describe('settings sheet', () => {
  test('takes the focus, keeps it inside, and gives it back on Escape', async ({ app, page }) => {
    await app.open();
    await app.settingsButton.focus();
    await page.keyboard.press('Enter');
    const settings = app.settings;
    await expect(settings).toBeVisible();
    await expect(settings).toHaveAttribute('aria-modal', 'true');
    await expectFocusWithin(settings);
    // Everything behind it is out of reach, for the keyboard and for assistive technology.
    await expect(page.locator('#page')).toHaveAttribute('inert', '');

    // Tab goes round inside the sheet, in both directions.
    const stops = await settings.evaluate(
      (element) =>
        element.querySelectorAll('button:not([disabled]), input, summary, [tabindex="0"]').length,
    );
    expect(stops).toBeGreaterThan(8);
    for (let step = 0; step < stops + 3; step++) {
      await page.keyboard.press('Tab');
      await expectFocusWithin(settings);
    }
    for (let step = 0; step < stops + 3; step++) {
      await page.keyboard.press('Shift+Tab');
      await expectFocusWithin(settings);
    }

    // The licences are folded away at first. Their link is a stop only once they are opened,
    // and then it is the last one: Tab goes from it to the first.
    const licences = settings.getByText(app.t('about.licenses'), { exact: true });
    const notices = settings.getByRole('link', { name: app.t('about.licenses.notices') });
    await expect(notices).toBeHidden();
    await licences.focus();
    await page.keyboard.press('Enter');
    await expect(notices).toBeVisible();
    await page.keyboard.press('Tab');
    await expect(notices).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(app.closeButton).toBeFocused();
    await page.keyboard.press('Shift+Tab');
    await expect(notices).toBeFocused();

    await page.keyboard.press('Escape');
    await expect(settings).toHaveCount(0);
    await expect(app.settingsButton).toBeFocused();
    await expect(page.locator('#page')).not.toHaveAttribute('inert', '');
  });

  test('closes with its close button and with a tap beside it', async ({ app, page }) => {
    await app.open();
    await app.openSettings();
    await app.closeButton.click();
    await expect(app.settings).toHaveCount(0);
    await expect(app.settingsButton).toBeFocused();

    await app.openSettings();
    // The scrim: whatever of the page is still visible around the sheet.
    await page.locator('.scrim').click({ position: { x: 8, y: 8 } });
    await expect(app.settings).toHaveCount(0);
    await expect(app.settingsButton).toBeFocused();
  });

  test('the back gesture closes it and stays in the app', async ({ app, page }) => {
    await app.open();
    const before = await historyLength(page);
    const url = page.url();

    await app.openSettings();
    expect(await historyLength(page)).toBe(before + 1);
    await page.goBack();
    await expect(app.settings).toHaveCount(0);
    expect(page.url()).toBe(url);
    await app.ready();
    await expect(app.settingsButton).toBeFocused();

    // Closing it any other way gives the history entry back, so that the next "back" is not
    // swallowed and opening it again does not pile entries up.
    for (let round = 0; round < 3; round++) {
      await app.openSettings();
      await page.keyboard.press('Escape');
      await expect(app.settings).toHaveCount(0);
    }
    await app.openSettings();
    expect(await historyLength(page)).toBe(before + 1);
    await page.goBack();
    await expect(app.settings).toHaveCount(0);
    await app.ready();
  });

  test('the page behind it does not scroll', async ({ app, page }) => {
    await app.open();
    await app.addFixtures(
      'aes-256-r6.pdf',
      'aes-128-r4.pdf',
      'rc4-128-r3.pdf',
      'rc4-40-r2.pdf',
      'plain.pdf',
      'owner-only-r6.pdf',
      'objstm-plain.pdf',
      'linearized-plain.pdf',
    );
    await app.analysed(8);
    await app.openSettings();
    await expect(page.locator('html')).toHaveClass(/is-locked/);
    expect(await page.evaluate(() => getComputedStyle(document.documentElement).overflow)).toBe(
      'hidden',
    );
    await app.closeDialog();
    await expect(page.locator('html')).not.toHaveClass(/is-locked/);
  });
});

test.describe('file menu and details', () => {
  test('the menu: arrow keys, Escape, and the focus back on its button', async ({ app, page }) => {
    await app.open();
    await app.addFixtures('aes-256-r6.pdf', 'plain.pdf');
    await app.analysed(2);

    const button = app.menuButton('plain.pdf');
    await button.focus();
    await page.keyboard.press('Enter');
    const menu = page.getByRole('menu');
    await expect(menu).toBeVisible();
    await expect(button).toHaveAttribute('aria-expanded', 'true');
    const items = menu.getByRole('menuitem');
    await expect(items).toHaveText([app.t('entry.menu.details'), app.t('entry.menu.remove')]);

    // On desktop the first item has the focus at once; arrows move through the items and wrap.
    if (!app.phone) await expect(items.first()).toBeFocused();
    else await items.first().focus();
    await page.keyboard.press('ArrowDown');
    await expect(items.nth(1)).toBeFocused();
    await page.keyboard.press('ArrowDown');
    await expect(items.first()).toBeFocused();
    await page.keyboard.press('End');
    await expect(items.nth(1)).toBeFocused();
    await page.keyboard.press('Home');
    await expect(items.first()).toBeFocused();

    await page.keyboard.press('Escape');
    await expect(menu).toHaveCount(0);
    await expect(button).toBeFocused();
    await expect(button).toHaveAttribute('aria-expanded', 'false');
    await expect(app.cards).toHaveCount(2);
  });

  test('the menu closes on a press elsewhere and with the back gesture', async ({ app, page }) => {
    await app.open();
    await app.addFixtures('aes-256-r6.pdf', 'plain.pdf');
    await app.analysed(2);
    const menu = page.getByRole('menu');

    await app.menuButton('aes-256-r6.pdf').click();
    await expect(menu).toBeVisible();
    if (app.phone) await page.locator('.scrim').click({ position: { x: 8, y: 8 } });
    else await page.getByRole('heading', { level: 1 }).click();
    await expect(menu).toHaveCount(0);

    await app.menuButton('aes-256-r6.pdf').click();
    await expect(menu).toBeVisible();
    await page.goBack();
    await expect(menu).toHaveCount(0);
    await app.ready();
    await expect(app.cards).toHaveCount(2);
  });

  test('the menu of a file further down the list opens and stays open', async ({ app, page }) => {
    await app.open();
    await app.addFixtures(
      'aes-256-r6.pdf',
      'aes-128-r4.pdf',
      'rc4-128-r3.pdf',
      'rc4-40-r2.pdf',
      'owner-only-r6.pdf',
      'owner-only-r4.pdf',
      'objstm-plain.pdf',
      'linearized-plain.pdf',
      'attachment-r6.pdf',
      'unicode-raw-r6.pdf',
      'cleartext-metadata-r6.pdf',
      'plain.pdf',
    );
    await app.analysed(12);
    await page.evaluate(() => window.scrollTo(0, 0));

    // The button is below the fold: it is scrolled into view and pressed in one go, the way a
    // screen reader activates it. The scroll that brought it there must not close the menu.
    const button = app.menuButton('plain.pdf');
    await expect(button).not.toBeInViewport();
    await button.click();
    const menu = page.getByRole('menu');
    await expect(menu).toBeVisible();
    await expect(menu).toBeInViewport({ ratio: 1 });
    await app.menuItem('entry.menu.remove').click();
    await expect(app.cards).toHaveCount(11);

    // Scrolling the page with the menu open does close it (desktop: it would point at nothing).
    await app.menuButton('cleartext-metadata-r6.pdf').click();
    await expect(menu).toBeVisible();
    if (!app.phone) {
      await page.mouse.wheel(0, -400);
      await expect(menu).toHaveCount(0);
    }
  });

  test('details opened from the menu return the focus to the menu button', async ({
    app,
    page,
  }) => {
    await app.open();
    await app.addFixtures('aes-256-r6.pdf', 'plain.pdf');
    await app.analysed(2);
    const before = await historyLength(page);

    const details = await app.openDetails('aes-256-r6.pdf');
    await expectFocusWithin(details);
    // Menu and details share one history entry: one "back" closes, it does not reopen the menu.
    expect(await historyLength(page)).toBe(before + 1);
    await page.keyboard.press('Escape');
    await expect(details).toHaveCount(0);
    await expect(app.menuButton('aes-256-r6.pdf')).toBeFocused();

    await app.openDetails('plain.pdf');
    await page.goBack();
    await expect(app.dialog).toHaveCount(0);
    await expect(page.getByRole('menu')).toHaveCount(0);
    await expect(app.menuButton('plain.pdf')).toBeFocused();
    await expect(app.cards).toHaveCount(2);
  });

  test('long details can be scrolled with the keyboard alone', async ({ app, page }) => {
    // A window too short for the details of an encrypted file.
    await page.setViewportSize({ width: app.phone ? 412 : 1440, height: 560 });
    await app.open();
    await app.addFixtures('rc4-40-r2.pdf', 'plain.pdf');
    await app.analysed(2);
    const details = await app.openDetails('rc4-40-r2.pdf');
    const body = details.locator('.sheet__body');
    expect(await body.evaluate((element) => element.scrollHeight > element.clientHeight)).toBe(
      true,
    );

    // Nothing in the details takes the focus, so the scrolling region itself is a Tab stop…
    await page.keyboard.press('Tab');
    await expect(app.closeButton).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(body).toBeFocused();
    // …and the keys that scroll, scroll it.
    await page.keyboard.press('End');
    await expect
      .poll(() =>
        body.evaluate(
          (element) => element.scrollTop + element.clientHeight >= element.scrollHeight - 1,
        ),
      )
      .toBe(true);
    await expect(details.getByText(app.t('details.permissions.withPassword'))).toBeInViewport();
    // The focus still goes round inside the dialog.
    await page.keyboard.press('Tab');
    await expect(app.closeButton).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(details).toHaveCount(0);

    // Where there are controls (settings), they are the Tab stops and the region is not.
    const settings = await app.openSettings();
    await expect(settings.locator('.sheet__body')).not.toHaveAttribute('tabindex');
  });

  test('removing a file from its menu leaves the focus on the page, not nowhere', async ({
    app,
    page,
  }) => {
    await app.open();
    await app.addFixtures('aes-256-r6.pdf', 'plain.pdf');
    await app.analysed(2);
    await app.menuCommand('plain.pdf', 'entry.menu.remove');
    await expect(app.cards).toHaveCount(1);
    await expect(page.getByRole('menu')).toHaveCount(0);
    await expect(page.locator('#main')).toBeFocused();
  });

  test('a sheet on the phone can be dragged away; a dialog on desktop cannot', async ({
    app,
    page,
  }) => {
    await app.open();
    const settings = await app.openSettings();
    const title = settings.getByRole('heading', { name: app.t('settings.title'), exact: true });
    // `hover` waits until the sheet has stopped sliding in, then puts the pointer on its header.
    const grab = async (): Promise<{ x: number; y: number }> => {
      await title.hover();
      const box = (await title.boundingBox())!;
      await page.mouse.down();
      return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
    };

    // A few pixels are no dismissal, however fast: the sheet springs back.
    let from = await grab();
    await page.mouse.move(from.x, from.y + 20, { steps: 4 });
    await page.mouse.up();
    await expect(settings).toBeVisible();
    if (app.phone) {
      await expect(settings).toHaveCSS('transform', /^(none|matrix\(1, 0, 0, 1, 0, 0\))$/);
    }

    from = await grab();
    await page.mouse.move(from.x, from.y + 220, { steps: 8 });
    await page.mouse.up();
    if (app.phone) {
      await expect(settings).toHaveCount(0);
      await expect(app.settingsButton).toBeFocused();
    } else {
      await expect(settings).toBeVisible();
      await expect(settings).toBeInViewport({ ratio: 1 });
    }
  });
});

test.describe('toasts', () => {
  test('say what happened, can be dismissed, and never take the focus', async ({ app, page }) => {
    await app.open();
    await app.addFixtures('aes-256-r6.pdf');
    await app.expectState('aes-256-r6.pdf', 'needs-password');
    await expect(app.unlockField).toBeFocused();

    await app.addFixtures('aes-256-r6.pdf');
    await app.expectToast('toast.duplicate', { name: 'aes-256-r6.pdf' });
    // Announced to assistive technology through the app's one live region.
    await expect(page.getByRole('status')).toContainText(
      app.t('toast.duplicate', { name: 'aes-256-r6.pdf' }),
    );
    await app.toasts.getByRole('button', { name: app.t('toast.dismiss'), exact: true }).click();
    await expect(app.toasts).toBeEmpty();
  });
});
