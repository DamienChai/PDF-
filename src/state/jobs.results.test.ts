/** Getting results out (save, share, open, auto-save) and the details sheet. */
import { describe, expect, it } from 'vitest';
import { DEMO_PASSWORD, createDemoFile } from '../../tests/support/fake-engine';
import { createHarness, tick, type Harness } from '../../tests/support/jobs-harness';

/** A harness with `names` already unlocked. */
async function unlocked(
  names: string[],
  options: Parameters<typeof createHarness>[0] = {},
): Promise<Harness> {
  const h = createHarness(options);
  await h.add(...names);
  await h.jobs.unlockAll(DEMO_PASSWORD);
  return h;
}

describe('saving one result', () => {
  it('opens the save dialog within the click and confirms with a toast', async () => {
    const h = await unlocked(['needs-password.pdf']);
    const entry = h.entry('needs-password.pdf');
    const saving = h.jobs.save(entry.id);
    // Synchronously: the picker needs the user gesture.
    expect(h.saved()).toEqual([{ via: 'saveFile', names: ['needs-password_unlocked.pdf'] }]);
    expect(entry.view.value.result!.saved).toBe(false);
    await saving;
    expect(entry.view.value.result!.saved).toBe(true);
    expect(h.toasts.toasts.value).toMatchObject([
      { message: { key: 'toast.saved' }, tone: 'success' },
    ]);
    expect(h.jobs.summary.value.results).toMatchObject({ count: 1, unsaved: 0 });
  });

  it('hands over the output of the engine under the output name', async () => {
    const h = await unlocked(['needs-password.pdf']);
    await h.jobs.save(h.entry('needs-password.pdf').id);
    const file = h.save.calls[0]!.files[0]!;
    expect(file.name).toBe('needs-password_unlocked.pdf');
    expect(await h.engine.inspect(file.blob)).toMatchObject({ encrypted: false, pageCount: 4 });
  });

  it('says "download started" where there is no save dialog', async () => {
    const h = await unlocked(['needs-password.pdf']);
    h.save.saveOutcome = 'downloaded';
    await h.jobs.save(h.entry('needs-password.pdf').id);
    expect(h.toastKeys()).toEqual(['toast.downloaded']);
    expect(h.view('needs-password.pdf').result!.saved).toBe(true);
  });

  it('stays quiet when the user dismisses the dialog', async () => {
    const h = await unlocked(['needs-password.pdf']);
    h.save.saveOutcome = 'cancelled';
    await h.jobs.save(h.entry('needs-password.pdf').id);
    expect(h.toastKeys()).toEqual([]);
    expect(h.view('needs-password.pdf').result!.saved).toBe(false);
  });

  it('reports a failure and does not call the file saved', async () => {
    const h = await unlocked(['needs-password.pdf']);
    h.save.saveOutcome = new DOMException('disk full', 'QuotaExceededError');
    await expect(h.jobs.save(h.entry('needs-password.pdf').id)).resolves.toBeUndefined();
    expect(h.toasts.toasts.value).toMatchObject([
      { message: { key: 'toast.saveFailed' }, tone: 'error' },
    ]);
    expect(h.view('needs-password.pdf').result!.saved).toBe(false);
  });

  it('does nothing for a file without a result or an unknown id', async () => {
    const h = createHarness();
    await h.add('needs-password.pdf');
    await h.jobs.save(h.entry('needs-password.pdf').id);
    await h.jobs.save('nope');
    await h.jobs.share('nope');
    h.jobs.open('nope');
    expect(h.saved()).toEqual([]);
    expect(h.toastKeys()).toEqual([]);
  });

  it('does not mark a newer result as saved when the file was processed again meanwhile', async () => {
    const h = await unlocked(['owner-only.pdf']);
    const entry = h.entry('owner-only.pdf');
    let finish: (outcome: 'saved') => void = () => undefined;
    h.save.saveFile = () => new Promise((resolve) => (finish = resolve));
    const saving = h.jobs.save(entry.id);
    h.jobs.redo(entry.id);
    await h.jobs.unlockAll();
    finish('saved');
    await saving;
    expect(entry.view.value.result!.saved).toBe(false);
  });
});

describe('sharing and opening', () => {
  it('opens the share sheet within the click', async () => {
    const h = await unlocked(['needs-password.pdf']);
    const sharing = h.jobs.share(h.entry('needs-password.pdf').id);
    expect(h.saved()).toEqual([{ via: 'shareFiles', names: ['needs-password_unlocked.pdf'] }]);
    await sharing;
    expect(h.toastKeys()).toEqual([]);
    // Shared is not saved.
    expect(h.view('needs-password.pdf').result!.saved).toBe(false);
  });

  it('stays quiet when sharing is dismissed', async () => {
    const h = await unlocked(['needs-password.pdf']);
    h.save.shareOutcome = 'cancelled';
    await h.jobs.share(h.entry('needs-password.pdf').id);
    expect(h.toastKeys()).toEqual([]);
  });

  it('points to saving when the platform refuses to share', async () => {
    const h = await unlocked(['needs-password.pdf']);
    h.save.shareOutcome = 'unsupported';
    await h.jobs.share(h.entry('needs-password.pdf').id);
    expect(h.toasts.toasts.value).toMatchObject([
      { message: { key: 'toast.shareUnsupported' }, tone: 'error' },
    ]);
  });

  it('reports an unexpected sharing failure', async () => {
    const h = await unlocked(['needs-password.pdf']);
    h.save.shareOutcome = new Error('share sheet crashed');
    await h.jobs.share(h.entry('needs-password.pdf').id);
    expect(h.toastKeys()).toEqual(['toast.shareFailed']);
  });

  it('opens a result in a new tab, and reports when that fails', async () => {
    const h = await unlocked(['needs-password.pdf']);
    const id = h.entry('needs-password.pdf').id;
    h.jobs.open(id);
    expect(h.saved()).toEqual([{ via: 'openInNewTab', names: ['needs-password_unlocked.pdf'] }]);
    h.save.broken = true;
    h.jobs.open(id);
    expect(h.toastKeys()).toEqual(['toast.openFailed']);
  });

  it('offers sharing only where the platform can share files', async () => {
    const able = await unlocked(['needs-password.pdf']);
    expect(able.view('needs-password.pdf').result!.canShare).toBe(true);
    expect(able.jobs.summary.value.canShareAll).toBe(true);
    expect(able.jobs.capabilities.canShareFiles).toBe(true);

    const unable = await unlocked(['needs-password.pdf'], {
      capabilities: { canShareFiles: false },
    });
    expect(unable.view('needs-password.pdf').result!.canShare).toBe(false);
    expect(unable.jobs.summary.value.canShareAll).toBe(false);
  });

  it('assumes nothing when the capabilities cannot be determined', async () => {
    const h = createHarness();
    h.save.getSaveCapabilities = () => {
      throw new Error('no navigator');
    };
    expect(h.jobs.capabilities).toEqual({
      canShareFiles: false,
      canPickSaveLocation: false,
      canPickDirectory: false,
    });
  });
});

describe('saving and sharing everything', () => {
  const three = ['needs-password.pdf', 'aes128.pdf', 'owner-only.pdf'];
  const outputs = ['needs-password_unlocked.pdf', 'aes128_unlocked.pdf', 'owner-only_unlocked.pdf'];

  it('bundles several results into one ZIP, named after the mode', async () => {
    const h = await unlocked(three);
    expect(h.jobs.summary.value).toMatchObject({
      results: { count: 3, unsaved: 3 },
      canSaveAll: true,
      canSaveToFolder: true,
    });
    const saving = h.jobs.saveAll();
    expect(h.saved()).toEqual([
      { via: 'saveAsZip', names: outputs, zipName: 'archive-unlock.zip' },
    ]);
    await saving;
    expect(h.toasts.toasts.value).toMatchObject([
      { message: { key: 'toast.savedCount', params: { count: 3 } }, tone: 'success' },
    ]);
    expect(h.jobs.summary.value.results.unsaved).toBe(0);
    expect(h.jobs.entries.value.every((entry) => entry.view.value.result!.saved)).toBe(true);
  });

  it('writes into a folder where the platform offers that', async () => {
    const h = await unlocked(three);
    await h.jobs.saveAll('folder');
    expect(h.saved()).toEqual([{ via: 'saveToDirectory', names: outputs }]);
    expect(h.toasts.toasts.value[0]!.message).toEqual({
      key: 'toast.savedCount',
      params: { count: 3 },
    });
  });

  it('falls back to a ZIP where folders cannot be picked', async () => {
    const h = await unlocked(three, { capabilities: { canPickDirectory: false } });
    expect(h.jobs.summary.value.canSaveToFolder).toBe(false);
    await h.jobs.saveAll('folder');
    expect(h.saved()[0]!.via).toBe('saveAsZip');
  });

  it('saves a single result as it is', async () => {
    const h = await unlocked(['needs-password.pdf']);
    expect(h.jobs.summary.value.canSaveToFolder).toBe(false);
    await h.jobs.saveAll('folder');
    expect(h.saved()).toEqual([{ via: 'saveFile', names: ['needs-password_unlocked.pdf'] }]);
    expect(h.toastKeys()).toEqual(['toast.saved']);
  });

  it('only includes results, in list order', async () => {
    const h = createHarness();
    await h.add('plain.pdf', 'owner-only.pdf', 'damaged.pdf', 'needs-password.pdf', 'slow.pdf');
    await h.jobs.unlockAll();
    await h.jobs.saveAll();
    expect(h.saved()[0]!.names).toEqual(['owner-only_unlocked.pdf', 'slow_unlocked.pdf']);
    expect(h.view('needs-password.pdf').state).toBe('needs-password');
  });

  it('says "download started" and marks everything saved for a downloaded archive', async () => {
    const h = await unlocked(three);
    h.save.saveOutcome = 'downloaded';
    await h.jobs.saveAll();
    expect(h.toastKeys()).toEqual(['toast.downloaded']);
    expect(h.jobs.summary.value.results.unsaved).toBe(0);
  });

  it('marks nothing saved when the dialog is dismissed or saving fails', async () => {
    const h = await unlocked(three);
    h.save.saveOutcome = 'cancelled';
    await h.jobs.saveAll();
    expect(h.toastKeys()).toEqual([]);
    h.save.saveOutcome = new Error('write failed');
    await h.jobs.saveAll('folder');
    expect(h.toastKeys()).toEqual(['toast.saveFailed']);
    expect(h.jobs.summary.value.results.unsaved).toBe(3);
  });

  it('shares all results at once', async () => {
    const h = await unlocked(three);
    const sharing = h.jobs.shareAll();
    expect(h.saved()).toEqual([{ via: 'shareFiles', names: outputs }]);
    await sharing;
    h.save.shareOutcome = 'unsupported';
    await h.jobs.shareAll();
    expect(h.toastKeys()).toEqual(['toast.shareUnsupported']);
  });

  it('does nothing without results', async () => {
    const h = createHarness();
    await h.add('needs-password.pdf');
    await h.jobs.saveAll();
    await h.jobs.shareAll();
    expect(h.saved()).toEqual([]);
    expect(h.jobs.summary.value).toMatchObject({ canSaveAll: false, canShareAll: false });
  });

  it('adds up the size of the results', async () => {
    const h = await unlocked(three);
    const sizes = h.jobs.entries.value.map((entry) => entry.view.value.result!.size);
    expect(h.jobs.summary.value.results.totalSize).toBe(sizes.reduce((a, b) => a + b, 0));
  });
});

describe('auto-save', () => {
  it('downloads a single result as soon as it is done, without a dialog', async () => {
    const h = createHarness({ settings: { autoSave: true } });
    await h.add('needs-password.pdf');
    await h.jobs.unlockAll(DEMO_PASSWORD);
    expect(h.saved()).toEqual([{ via: 'downloadFile', names: ['needs-password_unlocked.pdf'] }]);
    expect(h.view('needs-password.pdf').result!.saved).toBe(true);
    expect(h.toasts.toasts.value).toMatchObject([
      { message: { key: 'toast.autoSaved' }, tone: 'success' },
    ]);
  });

  it('downloads several results as one ZIP', async () => {
    const h = createHarness({ settings: { autoSave: true } });
    await h.add('needs-password.pdf', 'owner-only.pdf', 'plain.pdf', 'damaged.pdf');
    await h.jobs.unlockAll(DEMO_PASSWORD);
    expect(h.save.zips).toEqual([['needs-password_unlocked.pdf', 'owner-only_unlocked.pdf']]);
    expect(h.saved()).toEqual([{ via: 'downloadFile', names: ['archive-unlock.zip'] }]);
    expect(h.jobs.summary.value.results).toMatchObject({ count: 2, unsaved: 0 });
  });

  it('names the archive after the mode that produced it', async () => {
    const h = createHarness({ mode: 'lock', settings: { autoSave: true } });
    await h.add('plain.pdf', 'owner-only.pdf');
    h.fillLockForm();
    await h.jobs.lockAll();
    expect(h.saved()).toEqual([{ via: 'downloadFile', names: ['archive-lock.zip'] }]);
  });

  it('is off by default', async () => {
    const h = await unlocked(['needs-password.pdf']);
    expect(h.saved()).toEqual([]);
    expect(h.toastKeys()).toEqual([]);
  });

  it('follows the setting as it is when the run finishes', async () => {
    const h = createHarness({ engine: { hold: 0.5 } });
    await h.add('owner-only.pdf');
    const run = h.jobs.unlockAll();
    await tick();
    h.settings.value = { ...h.settings.value, autoSave: true };
    h.engine.release();
    await run;
    expect(h.saved()).toEqual([{ via: 'downloadFile', names: ['owner-only_unlocked.pdf'] }]);
  });

  it('delivers nothing when nothing succeeded', async () => {
    const h = createHarness({ settings: { autoSave: true }, engine: { hold: 0.5 } });
    await h.add('needs-password.pdf', 'read-failed.pdf', 'owner-only.pdf');
    h.jobs.setUnlockPassword('wrong');
    const run = h.jobs.unlockAll();
    await tick();
    h.jobs.cancel(h.entry('owner-only.pdf').id);
    h.engine.release();
    expect(await run).toEqual({ started: true, done: 0, rejected: 1, failed: 1, cancelled: 1 });
    expect(h.saved()).toEqual([]);
    expect(h.toastKeys()).toEqual([]);
  });

  it('delivers only what is new: earlier results are not downloaded again', async () => {
    const h = createHarness({ settings: { autoSave: true } });
    await h.add('owner-only.pdf');
    await h.jobs.unlockAll();
    await h.add('slow.pdf');
    await h.jobs.unlockAll();
    expect(h.saved()).toEqual([
      { via: 'downloadFile', names: ['owner-only_unlocked.pdf'] },
      { via: 'downloadFile', names: ['slow_unlocked.pdf'] },
    ]);
  });

  it('delivers a card retry too', async () => {
    const h = createHarness({ settings: { autoSave: true } });
    await h.add('needs-password.pdf', 'aes128.pdf');
    h.jobs.setUnlockPassword('wrong');
    await h.jobs.unlockAll();
    expect(h.saved()).toEqual([]);
    await h.jobs.retryUnlock(h.entry('aes128.pdf').id, DEMO_PASSWORD);
    expect(h.saved()).toEqual([{ via: 'downloadFile', names: ['aes128_unlocked.pdf'] }]);
  });

  it('delivers overlapping runs together, once', async () => {
    const h = createHarness({
      settings: { autoSave: true },
      engine: { hold: 0.5, concurrency: 4 },
    });
    await h.add('needs-password.pdf', 'aes128.pdf');
    const first = h.jobs.retryUnlock(h.entry('needs-password.pdf').id, DEMO_PASSWORD);
    await tick();
    const second = h.jobs.retryUnlock(h.entry('aes128.pdf').id, DEMO_PASSWORD);
    await tick();
    h.engine.release();
    await Promise.all([first, second]);
    await h.jobs.settled();
    expect(h.save.zips).toEqual([['needs-password_unlocked.pdf', 'aes128_unlocked.pdf']]);
    expect(h.saved()).toEqual([{ via: 'downloadFile', names: ['archive-unlock.zip'] }]);
  });

  it('reports a failed delivery and leaves the results unsaved', async () => {
    const h = createHarness({ settings: { autoSave: true } });
    h.save.broken = true;
    await h.add('needs-password.pdf', 'owner-only.pdf');
    await h.jobs.unlockAll(DEMO_PASSWORD);
    expect(h.toasts.toasts.value).toMatchObject([
      { message: { key: 'toast.saveFailed' }, tone: 'error' },
    ]);
    expect(h.jobs.summary.value.results).toMatchObject({ count: 2, unsaved: 2 });
    // They can still be saved by hand.
    h.save.broken = false;
    await h.jobs.saveAll();
    expect(h.jobs.summary.value.results.unsaved).toBe(0);
  });
});

describe('details', () => {
  it('describes a locked file as far as it can be read', async () => {
    const h = createHarness();
    await h.add('needs-password.pdf');
    const details = h.entry('needs-password.pdf').details.value;
    expect(details).toMatchObject({
      name: 'needs-password.pdf',
      size: 1_288_490,
      available: true,
      protection: { key: 'details.protection.password' },
      encrypted: true,
      algorithm: { key: 'algorithm.aes-256' },
      outdatedNote: null,
      keyLength: { key: 'details.bits', params: { bits: 256 } },
      pdfVersion: '2.0',
      pageCount: null,
      linearized: null,
      metadataEncrypted: true,
      permissionsNote: { key: 'details.permissions.withPassword' },
      warnings: [],
      result: null,
      error: null,
    });
    expect(details.permissions.map((row) => [row.id, row.status])).toEqual([
      ['print', 'denied'],
      ['extract', 'denied'],
      ['modify', 'denied'],
      ['annotate', 'allowed'],
      ['fillForms', 'allowed'],
      ['assemble', 'denied'],
      ['accessibility', 'allowed'],
    ]);
    expect(details.permissions[0]).toMatchObject({
      label: { key: 'permission.print' },
      statusLabel: { key: 'permission.denied' },
    });
  });

  it('fills in what is learnt by unlocking', async () => {
    const h = await unlocked(['needs-password.pdf']);
    expect(h.entry('needs-password.pdf').details.value).toMatchObject({
      pageCount: 4,
      result: { name: 'needs-password_unlocked.pdf', verified: true },
    });
  });

  it('describes restrictions, low-resolution printing and outdated encryption', async () => {
    const h = createHarness();
    await h.add('owner-only.pdf', 'rc4-40.pdf');
    expect(h.entry('owner-only.pdf').details.value).toMatchObject({
      protection: { key: 'details.protection.restrictions' },
      pageCount: 31,
      linearized: false,
    });
    const rc4 = h.entry('rc4-40.pdf').details.value;
    expect(rc4).toMatchObject({
      algorithm: { key: 'algorithm.rc4', params: { bits: 40 } },
      outdatedNote: { key: 'details.outdated' },
      keyLength: { params: { bits: 40 } },
      pdfVersion: '1.3',
    });
    expect(rc4.permissions[0]).toMatchObject({
      id: 'print',
      status: 'limited',
      statusLabel: { key: 'permission.lowResolution' },
    });
  });

  it('shows everything as allowed for a file that is not encrypted', async () => {
    const h = createHarness();
    await h.add('plain.pdf');
    const details = h.entry('plain.pdf').details.value;
    expect(details).toMatchObject({
      protection: { key: 'details.protection.none' },
      encrypted: false,
      algorithm: null,
      keyLength: null,
      metadataEncrypted: null,
      permissionsNote: { key: 'details.permissions.all' },
      pageCount: 12,
    });
    expect(details.permissions.every((row) => row.status === 'allowed')).toBe(true);
    expect(details.permissions).toHaveLength(7);
  });

  it('passes on the warnings of the engine', async () => {
    const h = createHarness();
    await h.add('repaired.pdf');
    expect(h.entry('repaired.pdf').details.value.warnings).toHaveLength(3);
    expect(h.view('repaired.pdf').warning).toEqual({
      key: 'entry.warnings',
      params: { count: 3 },
    });
    expect(h.view('repaired.pdf').state).toBe('needs-password');
  });

  it('has little to say while analysing or after a failure', async () => {
    const h = createHarness({ engine: { hold: 'inspect' } });
    await h.jobs.addFiles([createDemoFile('damaged.pdf')], 'picker');
    const entry = h.entry('damaged.pdf');
    expect(entry.details.value).toMatchObject({
      name: 'damaged.pdf',
      available: false,
      protection: null,
      permissions: [],
      error: null,
    });
    h.engine.release();
    await h.jobs.settled();
    expect(entry.details.value).toMatchObject({
      available: false,
      error: { code: 'damaged', title: { key: 'error.damaged.title' } },
    });
  });

  it('follows the mode', async () => {
    const h = createHarness();
    await h.add('owner-only.pdf');
    await h.jobs.unlockAll();
    const entry = h.entry('owner-only.pdf');
    expect(entry.details.value.result).not.toBeNull();
    h.mode.value = 'lock';
    expect(entry.details.value.result).toBeNull();
    expect(entry.details.value.protection).toEqual({ key: 'details.protection.restrictions' });
  });
});
