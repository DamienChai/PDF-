/**
 * "How is this PDF protected?": the details of a file, a bottom sheet on the phone and a dialog on
 * desktop. What it shows is compared with what manifest.json records about each fixture.
 */
import type { Locator } from '@playwright/test';
import { expect, test, type App } from './support/app';
import { fixture, unlockedName, type OkFixture } from './support/files';

/** The value shown next to a label in the grid of facts. */
function fact(details: Locator, label: string): Locator {
  return details
    .getByRole('term')
    .filter({ hasText: new RegExp(`^${label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`) })
    .locator('xpath=following-sibling::dd[1]');
}

/** The permissions table says exactly what the file's permission flags say. */
async function expectPermissions(app: App, details: Locator, source: OkFixture): Promise<void> {
  const rows = details.getByRole('listitem');
  await expect(rows).toHaveCount(7);
  const permissions = source.encryption?.permissions;
  const expected = (value: boolean | 'full' | 'low' | 'none' | undefined) =>
    value === undefined || value === true || value === 'full'
      ? app.t('permission.allowed')
      : value === 'low'
        ? app.t('permission.lowResolution')
        : app.t('permission.denied');
  const table = [
    ['permission.print', permissions?.print],
    ['permission.modify', permissions?.modify],
    ['permission.extract', permissions?.extract],
    ['permission.annotate', permissions?.annotate],
    ['permission.fillForms', permissions?.fillForms],
    ['permission.assemble', permissions?.assemble],
    ['permission.accessibility', permissions?.accessibility],
  ] as const;
  for (const [label, value] of table) {
    await expect(rows.filter({ hasText: app.t(label) })).toHaveText(
      `${app.t(label)}${expected(value)}`,
    );
  }
}

test.describe('file details', () => {
  test('an encrypted file: algorithm, key length, version, permissions', async ({ app }) => {
    const source = fixture('aes-256-r6.pdf');
    await app.open();
    await app.addFixtures(source.file);
    await app.expectState(source.file, 'needs-password');

    const details = await app.openDetails(source.file);
    await expect(details).toHaveAttribute('aria-modal', 'true');
    await expect(details).toContainText(app.t('details.protection.password'));
    await expect(details).toContainText(app.t('details.summary.password'));
    await expect(fact(details, app.t('details.algorithm'))).toHaveText('AES-256');
    await expect(fact(details, app.t('details.keyLength'))).toHaveText(
      app.t('details.bits', { bits: 256 }),
    );
    await expect(fact(details, app.t('details.pdfVersion'))).toHaveText(source.pdfVersion);
    // Pages cannot be counted while the file is locked, and the sheet says why.
    await expect(fact(details, app.t('details.pages'))).toHaveText(app.t('details.unknown'));
    await expect(fact(details, app.t('details.size'))).toHaveText(/7\.71 KB/);
    await expect(fact(details, app.t('details.metadata'))).toHaveText(
      app.t('details.metadata.encrypted'),
    );
    await expect(details).toContainText(app.t('details.permissions.withPassword'));
    await expectPermissions(app, details, source);
    await app.closeDialog();

    // Once unlocked the same sheet also describes what was produced.
    await app.unlockWith(source.userPassword!);
    await app.expectState(source.file, 'done');
    const after = await app.openDetails(source.file);
    await expect(fact(after, app.t('details.pages'))).toHaveText(String(source.pageCount));
    await expect(after.getByRole('heading', { name: app.t('details.output') })).toBeVisible();
    await expect(after).toContainText(unlockedName(source.file));
    await expect(fact(after, app.t('details.duration'))).not.toBeEmpty();
    await expect(after).toContainText(app.t('details.verified'));
  });

  test('a plain file: not encrypted, nothing restricted', async ({ app }) => {
    const source = fixture('linearized-plain.pdf');
    await app.open();
    await app.addFixtures(source.file);
    await app.expectState(source.file, 'not-encrypted');

    const details = await app.openDetails(source.file);
    await expect(details).toContainText(app.t('details.summary.none'));
    await expect(details).toContainText(app.t('details.protection.none'));
    // No encryption, so no facts about one.
    await expect(fact(details, app.t('details.algorithm'))).toHaveCount(0);
    await expect(fact(details, app.t('details.keyLength'))).toHaveCount(0);
    await expect(fact(details, app.t('details.pdfVersion'))).toHaveText(source.pdfVersion);
    await expect(fact(details, app.t('details.pages'))).toHaveText(String(source.pageCount));
    await expect(fact(details, app.t('details.fastWebView'))).toHaveText(app.t('details.yes'));
    await expect(fact(details, app.t('details.metadata'))).toHaveCount(0);
    await expect(details).toContainText(app.t('details.permissions.all'));
    await expectPermissions(app, details, source);
  });

  test('an RC4 file is called outdated, with advice', async ({ app }) => {
    const source = fixture('rc4-40-r2.pdf');
    await app.open();
    await app.addFixtures(source.file);
    await app.expectState(source.file, 'needs-password');
    await expect(app.card(source.file)).toContainText('RC4-40');

    const details = await app.openDetails(source.file);
    await expect(fact(details, app.t('details.algorithm'))).toHaveText(
      app.t('algorithm.rc4', { bits: 40 }),
    );
    await expect(fact(details, app.t('details.keyLength'))).toHaveText(
      app.t('details.bits', { bits: 40 }),
    );
    await expect(details).toContainText(app.t('details.outdated'));
    // This one even forbids reading by assistive technology.
    await expectPermissions(app, details, source);
  });

  for (const file of ['owner-only-r6.pdf', 'aes-128-r4.pdf', 'cleartext-metadata-r6.pdf']) {
    test(`${file}: the permissions table matches the file`, async ({ app }) => {
      const source = fixture(file);
      await app.open();
      await app.addFixtures(source.file);
      await app.analysed(1);
      const details = await app.openDetails(source.file);
      await expect(details).toContainText(
        app.t(
          source.opensWithoutPassword
            ? 'details.protection.restrictions'
            : 'details.protection.password',
        ),
      );
      await expect(fact(details, app.t('details.metadata'))).toHaveText(
        app.t(
          source.encryption!.encryptMetadata
            ? 'details.metadata.encrypted'
            : 'details.metadata.clear',
        ),
      );
      await expectPermissions(app, details, source);
    });
  }

  test('a file that cannot be read: the error and its technical detail', async ({ app }) => {
    await app.open();
    await app.addFixtures('damaged-unrecoverable.pdf');
    await app.expectState('damaged-unrecoverable.pdf', 'error');
    const details = await app.openDetails('damaged-unrecoverable.pdf');
    await expect(details).toContainText(app.t('details.summary.unavailable'));
    await expect(details).toContainText(app.t('error.damaged.title'));
    await expect(details).toContainText(app.t('error.damaged.advice'));
    await expect(details.locator('pre')).not.toBeEmpty();
    await expect(details.getByRole('listitem')).toHaveCount(0);
  });
});
