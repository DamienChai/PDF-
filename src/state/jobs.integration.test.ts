/**
 * The controller against the real engine (qpdf in WebAssembly, in its in-thread mode: Node has no
 * Web Workers) and the committed fixtures: what the app does, minus the DOM.
 */
import { afterAll, describe, expect, it } from 'vitest';
import {
  blobBytes,
  containsStreams,
  fixture,
  fixtureBytes,
  streamHashes,
} from '../engine/test-support';
import { createHarness, type Harness } from '../../tests/support/jobs-harness';
import { engineState } from './engine';

const engine = engineState.engine;

afterAll(() => {
  engineState.dispose();
});

function fixtureFile(name: string): File {
  return new File([fixtureBytes(name) as BlobPart], name, { type: 'application/pdf' });
}

async function load(h: Harness, ...names: string[]): Promise<void> {
  await h.jobs.addFiles(names.map(fixtureFile), 'picker');
  await h.jobs.settled();
}

/** The blob behind a result, obtained the way the UI would: by saving it. */
async function output(h: Harness, name: string): Promise<{ name: string; blob: Blob }> {
  const before = h.save.calls.length;
  await h.jobs.save(h.entry(name).id);
  const call = h.save.calls[before];
  expect(call?.via).toBe('saveFile');
  return call!.files[0]!;
}

describe('unlocking with the real engine', () => {
  it('inspects fixtures into the right card states', async () => {
    const h = createHarness({ realEngine: engine });
    await load(
      h,
      'aes-256-r6.pdf',
      'owner-only-r6.pdf',
      'plain.pdf',
      'rc4-40-r2.pdf',
      'damaged-unrecoverable.pdf',
      'nonstandard-handler.pdf',
    );
    expect(h.states()).toEqual([
      'needs-password',
      'restricted',
      'not-encrypted',
      'needs-password',
      'error',
      'error',
    ]);
    expect(h.view('aes-256-r6.pdf')).toMatchObject({
      algorithm: { label: { key: 'algorithm.chip.aes-256' }, outdated: false },
      size: fixture('aes-256-r6.pdf').size,
      pageCount: null,
    });
    expect(h.view('rc4-40-r2.pdf').algorithm).toEqual({
      label: { key: 'algorithm.chip.rc4', params: { bits: 40 } },
      outdated: true,
    });
    expect(h.view('plain.pdf').pageCount).toBe(4);
    expect(h.view('damaged-unrecoverable.pdf').error!.code).toBe('damaged');
    expect(h.view('nonstandard-handler.pdf').error!.code).toBe('unsupported-encryption');
    expect(h.entry('aes-256-r6.pdf').details.value).toMatchObject({
      available: true,
      protection: { key: 'details.protection.password' },
      keyLength: { params: { bits: 256 } },
      pdfVersion: fixture('aes-256-r6.pdf').pdfVersion,
    });
  });

  it('learns the engine version on the way', async () => {
    const info = await engineState.load();
    expect(info?.qpdfVersion).toMatch(/^\d+\.\d+\.\d+$/);
    expect(engineState.status.value).toBe('ready');
    expect(engineState.info.value?.mode).toBe('main-thread');
  });

  it('rejects files that are not PDFs before the engine sees them', async () => {
    const h = createHarness({ realEngine: engine });
    await load(h, 'not-a-pdf.bin', 'text-not-pdf.bin', 'junk-prefix-r6.pdf');
    expect(h.jobs.entries.value.map((entry) => entry.name)).toEqual(['junk-prefix-r6.pdf']);
    expect(h.toastKeys()).toEqual(['toast.notPdfCount']);
    expect(h.states()).toEqual(['needs-password']);
  });

  it('unlocks an AES-256 file: wrong password first, then the right one', async () => {
    const source = fixture('aes-256-r6.pdf');
    const h = createHarness({ realEngine: engine });
    await load(h, source.file);

    h.jobs.setUnlockPassword(source.wrongPassword);
    expect(await h.jobs.unlockAll()).toMatchObject({ started: true, done: 0, rejected: 1 });
    expect(h.view(source.file)).toMatchObject({ state: 'wrong-password', result: null });
    expect(h.jobs.summary.value.passwordError).toEqual({ key: 'unlock.password.wrong' });
    expect(h.jobs.unlockPassword.value).toBe(source.wrongPassword);

    h.jobs.setUnlockPassword(source.userPassword!);
    expect(await h.jobs.unlockAll()).toMatchObject({ done: 1, rejected: 0 });
    expect(h.jobs.unlockPassword.value).toBe('');
    const view = h.view(source.file);
    expect(view).toMatchObject({
      state: 'done',
      pageCount: source.pageCount,
      result: { name: 'aes-256-r6_unlocked.pdf', verified: true, inputSize: source.size },
    });

    const saved = await output(h, source.file);
    expect(saved.blob.size).toBe(view.result!.size);
    expect(await engine.inspect(saved.blob)).toMatchObject({
      encrypted: false,
      access: 'none',
      pageCount: source.pageCount,
    });
    // The pages are the same as in the original, byte for byte once decoded.
    const bytes = await blobBytes(saved.blob);
    expect(containsStreams(bytes, source.pageContentSha256)).toBe(true);
    expect(streamHashes(bytes).size).toBeGreaterThan(0);
  });

  it('unlocks with the owner password as well', async () => {
    const source = fixture('aes-256-r6.pdf');
    const h = createHarness({ realEngine: engine });
    await load(h, source.file);
    expect(await h.jobs.unlockAll(source.ownerPassword!)).toMatchObject({ done: 1 });
  });

  it('removes restrictions without any password', async () => {
    const source = fixture('owner-only-r6.pdf');
    const h = createHarness({ realEngine: engine });
    await load(h, source.file);
    expect(h.view(source.file)).toMatchObject({ state: 'restricted', pageCount: source.pageCount });
    expect(h.jobs.summary.value).toMatchObject({
      passwordField: false,
      primary: { kind: 'remove-restrictions', enabled: true },
    });

    expect(await h.jobs.runPrimary()).toMatchObject({ started: true, done: 1 });
    const saved = await output(h, source.file);
    expect(saved.name).toBe('owner-only-r6_unlocked.pdf');
    expect(await engine.inspect(saved.blob)).toMatchObject({
      encrypted: false,
      pageCount: source.pageCount,
    });
    const bytes = await blobBytes(saved.blob);
    expect(containsStreams(bytes, source.pageContentSha256)).toBe(true);
  });

  it('passes passwords through exactly as typed, whatever the script', async () => {
    const source = fixture('unicode-saslprep-r6.pdf');
    const legacy = fixture('gbk-r3.pdf');
    const h = createHarness({ realEngine: engine });
    await load(h, source.file, legacy.file);
    await h.jobs.unlockAll(source.userPassword!);
    expect(h.states()).toEqual(['done', 'wrong-password']);
    await h.jobs.retryUnlock(h.entry(legacy.file).id, legacy.userPassword!);
    expect(h.states()).toEqual(['done', 'done']);
  });

  it('handles a mixed batch in one go, with distinct output names', async () => {
    const h = createHarness({ realEngine: engine });
    await load(h, 'aes-256-r6.pdf', 'aes-128-r4.pdf', 'owner-only-r3.pdf', 'plain.pdf');
    const report = await h.jobs.unlockAll('user');
    expect(report).toEqual({ started: true, done: 3, rejected: 0, failed: 0, cancelled: 0 });
    expect(h.states()).toEqual(['done', 'done', 'done', 'not-encrypted']);
    await h.jobs.saveAll();
    expect(h.saved().at(-1)).toEqual({
      via: 'saveAsZip',
      names: ['aes-256-r6_unlocked.pdf', 'aes-128-r4_unlocked.pdf', 'owner-only-r3_unlocked.pdf'],
      zipName: 'archive-unlock.zip',
    });
  });

  it('applies the output options', async () => {
    const h = createHarness({
      realEngine: engine,
      settings: { output: { optimizeSize: true, linearize: true } },
    });
    await load(h, 'owner-only-r6.pdf');
    await h.jobs.unlockAll();
    const saved = await output(h, 'owner-only-r6.pdf');
    expect(await engine.inspect(saved.blob)).toMatchObject({ encrypted: false, linearized: true });
  });
});

describe('locking with the real engine', () => {
  it('locks a plain file with the form, and the output is really encrypted', async () => {
    const source = fixture('plain.pdf');
    const password = 'Vq7#mTz2!pLx9@Rw';
    const h = createHarness({ realEngine: engine, mode: 'lock' });
    await load(h, source.file);
    expect(h.view(source.file).state).toBe('ready');

    expect((await h.jobs.lockAll()).refusal).toBe('invalid-form');
    h.fillLockForm(password);
    expect(await h.jobs.lockAll()).toEqual({
      started: true,
      done: 1,
      rejected: 0,
      failed: 0,
      cancelled: 0,
    });
    expect(h.view(source.file)).toMatchObject({
      state: 'done',
      algorithm: { label: { key: 'algorithm.chip.aes-256' } },
      result: { name: 'plain_locked.pdf', verified: true, pageCount: source.pageCount },
    });

    const saved = await output(h, source.file);
    const locked = await engine.inspect(saved.blob);
    expect(locked).toMatchObject({
      encrypted: true,
      access: 'locked',
      opensWithoutPassword: false,
      pageCount: null,
      encryption: { algorithm: 'aes-256', keyBits: 256, revision: 6, encryptMetadata: true },
    });
    expect((await engine.inspect(saved.blob, 'wrong')).access).toBe('locked');
    expect(await engine.inspect(saved.blob, password)).toMatchObject({
      access: 'both',
      pageCount: source.pageCount,
    });
    // The plain page content is no longer readable in the file.
    expect(containsStreams(await blobBytes(saved.blob), source.pageContentSha256)).toBe(false);
  });

  it('locks with a separate permissions password and restrictions', async () => {
    const h = createHarness({ realEngine: engine, mode: 'lock' });
    await load(h, 'plain.pdf');
    h.lockForm.setSeparateOwner(true);
    h.lockForm.setOwnerPassword('boss-Passw0rd');
    h.lockForm.setPermission('print', 'low');
    h.lockForm.setPermission('extract', false);
    h.lockForm.setPermission('annotate', false);
    h.lockForm.setAlgorithm('aes-128');
    expect(await h.jobs.lockAll()).toMatchObject({ done: 1 });

    const saved = await output(h, 'plain.pdf');
    const restricted = await engine.inspect(saved.blob);
    expect(restricted).toMatchObject({
      encrypted: true,
      access: 'user',
      opensWithoutPassword: true,
      encryption: {
        algorithm: 'aes-128',
        permissions: {
          print: 'low',
          extract: false,
          annotate: false,
          fillForms: false,
          modify: true,
          assemble: true,
          accessibility: true,
        },
      },
    });
    expect((await engine.inspect(saved.blob, 'boss-Passw0rd')).access).toBe('owner');
  });

  it('changes the protection of an encrypted file, given its current password', async () => {
    const source = fixture('rc4-128-r3.pdf');
    const h = createHarness({ realEngine: engine, mode: 'lock' });
    await load(h, source.file);
    const entry = h.entry(source.file);
    expect(entry.view.value).toMatchObject({ state: 'encrypted', password: { kind: 'current' } });
    h.fillLockForm('brand-new-Passw0rd');

    h.jobs.setCurrentPassword(entry.id, source.wrongPassword);
    expect(await h.jobs.lockAll()).toMatchObject({ done: 0, rejected: 1 });
    expect(entry.view.value).toMatchObject({
      state: 'wrong-password',
      password: { error: { key: 'entry.currentPassword.wrong' } },
    });

    h.jobs.setCurrentPassword(entry.id, source.userPassword!);
    expect(await h.jobs.lockAll()).toMatchObject({ done: 1 });
    expect(entry.currentPassword.value).toBe('');

    const saved = await output(h, source.file);
    expect(saved.name).toBe('rc4-128-r3_locked.pdf');
    expect((await engine.inspect(saved.blob, source.userPassword!)).access).toBe('locked');
    expect(await engine.inspect(saved.blob, 'brand-new-Passw0rd')).toMatchObject({
      access: 'both',
      pageCount: source.pageCount,
      encryption: { algorithm: 'aes-256' },
    });
  });

  it('round-trips: what was locked can be unlocked again', async () => {
    const source = fixture('plain.pdf');
    const password = '密码 Pass 123';
    const h = createHarness({ realEngine: engine, mode: 'lock' });
    await load(h, source.file);
    h.lockForm.setRevealed(true);
    h.lockForm.setPassword(password);
    await h.jobs.lockAll();
    const locked = await output(h, source.file);

    h.jobs.clear();
    h.mode.value = 'unlock';
    await h.jobs.addFiles([new File([locked.blob], locked.name)], 'picker');
    await h.jobs.settled();
    expect(h.states()).toEqual(['needs-password']);
    expect(await h.jobs.unlockAll(password)).toMatchObject({ done: 1 });
    const unlocked = await output(h, locked.name);
    // The suffix is swapped, not stacked.
    expect(unlocked.name).toBe('plain_unlocked.pdf');
    expect(containsStreams(await blobBytes(unlocked.blob), source.pageContentSha256)).toBe(true);
  });
});
