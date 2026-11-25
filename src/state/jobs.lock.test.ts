/** The file list in Lock mode, and how the two modes live side by side. */
import { describe, expect, it } from 'vitest';
import { ALL_PERMISSIONS, type EncryptOptions } from '../engine/types';
import {
  DEMO_OWNER_PASSWORD,
  DEMO_PASSWORD,
  createDemoFile,
} from '../../tests/support/fake-engine';
import { createHarness, tick } from '../../tests/support/jobs-harness';

const NEW_PASSWORD = 'new-Passw0rd!';

const options: EncryptOptions = {
  algorithm: 'aes-256',
  userPassword: NEW_PASSWORD,
  ownerPassword: '',
  permissions: { ...ALL_PERMISSIONS },
  encryptMetadata: true,
};

function lockHarness(...args: Parameters<typeof createHarness>) {
  return createHarness({ mode: 'lock', ...args[0] });
}

describe('lock: card states', () => {
  it('analysing', async () => {
    const h = lockHarness({ engine: { hold: 'inspect' } });
    await h.jobs.addFiles([createDemoFile('plain.pdf')], 'picker');
    expect(h.view('plain.pdf')).toMatchObject({ state: 'analysing', mode: 'lock' });
    expect(h.jobs.summary.value).toMatchObject({ phase: 'analysing', primary: null });
  });

  it('ready: not encrypted, will be encrypted', async () => {
    const h = lockHarness();
    await h.add('plain.pdf');
    expect(h.view('plain.pdf')).toMatchObject({
      state: 'ready',
      chip: { label: { key: 'chip.notEncrypted' }, tone: 'neutral' },
      note: { key: 'entry.note.willEncrypt' },
      algorithm: null,
      password: null,
    });
    expect(h.jobs.summary.value).toMatchObject({
      mode: 'lock',
      phase: 'ready',
      actionable: 1,
      needPassword: 0,
      passwordField: false,
      primary: { kind: 'lock', label: { key: 'action.lock' }, count: 1, enabled: true },
      status: null,
      suggestion: null,
    });
  });

  it('already encrypted with an open password: asks for the current password', async () => {
    const h = lockHarness();
    await h.add('aes128.pdf');
    expect(h.view('aes128.pdf')).toMatchObject({
      state: 'encrypted',
      chip: { label: { key: 'chip.encrypted' }, tone: 'info' },
      note: { key: 'entry.note.willReplace' },
      algorithm: { label: { key: 'algorithm.chip.aes-128' } },
      password: {
        kind: 'current',
        label: { key: 'entry.currentPassword.label' },
        placeholder: { key: 'entry.currentPassword.placeholder' },
        hint: { key: 'entry.note.needsCurrentPassword' },
        error: null,
        submitLabel: null,
      },
    });
    expect(h.jobs.summary.value).toMatchObject({
      phase: 'ready',
      actionable: 0,
      needPassword: 1,
      primary: { kind: 'lock', label: { key: 'action.lock' }, count: 0, enabled: false },
      status: { key: 'status.nothingToLock' },
    });

    h.jobs.setCurrentPassword(h.entry('aes128.pdf').id, 'anything');
    expect(h.entry('aes128.pdf').currentPassword.value).toBe('anything');
    expect(h.jobs.summary.value).toMatchObject({
      actionable: 1,
      needPassword: 0,
      primary: { count: 1, enabled: true },
      status: null,
    });
  });

  it('already encrypted without an open password: nothing to ask', async () => {
    const h = lockHarness();
    await h.add('owner-only.pdf');
    expect(h.view('owner-only.pdf')).toMatchObject({
      state: 'encrypted',
      note: { key: 'entry.note.willReplace' },
      password: null,
    });
    expect(h.jobs.summary.value.primary).toMatchObject({ count: 1, enabled: true });
  });

  it('processing, then done with the new algorithm', async () => {
    const h = lockHarness({ engine: { hold: 0.5 } });
    await h.add('plain.pdf');
    h.fillLockForm();
    const run = h.jobs.lockAll();
    await tick();
    expect(h.view('plain.pdf')).toMatchObject({ state: 'processing', canCancel: true });
    expect(h.entry('plain.pdf').progress.value).toBe(0.5);
    expect(h.jobs.summary.value.phase).toBe('processing');

    h.engine.release();
    expect(await run).toEqual({ started: true, done: 1, rejected: 0, failed: 0, cancelled: 0 });
    expect(h.view('plain.pdf')).toMatchObject({
      state: 'done',
      chip: { label: { key: 'chip.locked' }, tone: 'success' },
      algorithm: { label: { key: 'algorithm.chip.aes-256' }, outdated: false },
      result: { name: 'plain_locked.pdf', verified: true, saved: false },
      canRedo: true,
    });
    expect(h.jobs.summary.value).toMatchObject({
      phase: 'finished',
      status: { key: 'status.locked', params: { count: 1 } },
      canSaveAll: true,
    });
  });

  it('shows AES-128 on the result when that was chosen', async () => {
    const h = lockHarness();
    await h.add('plain.pdf');
    h.lockForm.setAlgorithm('aes-128');
    h.fillLockForm('simple-pass');
    await h.jobs.lockAll();
    expect(h.view('plain.pdf').algorithm).toEqual({
      label: { key: 'algorithm.chip.aes-128' },
      outdated: false,
    });
  });

  it('error while inspecting and while processing', async () => {
    const h = lockHarness();
    await h.add('damaged.pdf', 'crash.pdf');
    expect(h.view('damaged.pdf')).toMatchObject({ state: 'error', error: { code: 'damaged' } });
    h.fillLockForm();
    expect(await h.jobs.lockAll()).toMatchObject({ started: true, failed: 1 });
    const crashed = h.entry('crash.pdf');
    expect(crashed.view.value).toMatchObject({
      state: 'error',
      error: { code: 'internal', detail: expect.stringContaining('crashed') },
      canRetry: true,
    });
    h.jobs.retry(crashed.id);
    expect(crashed.view.value.state).toBe('ready');
  });
});

describe('lock: validation comes first', () => {
  it('refuses to start with an invalid form, shows the problems, and runs nothing', async () => {
    const h = lockHarness();
    await h.add('plain.pdf');
    const report = await h.jobs.lockAll();
    expect(report).toEqual({
      started: false,
      refusal: 'invalid-form',
      field: 'password',
      done: 0,
      rejected: 0,
      failed: 0,
      cancelled: 0,
    });
    expect(h.lockForm.errors.value.password).toEqual({ key: 'lock.error.required' });
    expect(h.engine.calls.process).toEqual([]);
    expect(h.states()).toEqual(['ready']);
  });

  it('reports a missing confirmation and a mismatch', async () => {
    const h = lockHarness();
    await h.add('plain.pdf');
    h.lockForm.setPassword(NEW_PASSWORD);
    expect(await h.jobs.lockAll()).toMatchObject({ started: false, field: 'confirmation' });
    expect(h.lockForm.errors.value.confirmation).toEqual({ key: 'lock.error.confirmRequired' });
    h.lockForm.setConfirmation('something else');
    expect(await h.jobs.lockAll()).toMatchObject({ started: false, field: 'confirmation' });
    expect(h.lockForm.errors.value.confirmation).toEqual({ key: 'lock.error.mismatch' });
    expect(h.engine.calls.process).toEqual([]);
  });

  it('reports passwords the algorithm cannot take', async () => {
    const h = lockHarness();
    await h.add('plain.pdf');
    h.lockForm.setAlgorithm('aes-128');
    h.lockForm.setRevealed(true);
    h.lockForm.setPassword('密码');
    expect(await h.jobs.lockAll()).toMatchObject({ started: false, refusal: 'invalid-form' });
    h.lockForm.setPassword('x'.repeat(40));
    expect(await h.jobs.lockAll()).toMatchObject({ started: false, refusal: 'invalid-form' });
    expect(h.engine.calls.process).toEqual([]);
  });

  it('checks options that are passed in directly', async () => {
    const h = lockHarness();
    await h.add('plain.pdf');
    expect((await h.jobs.lockAll({ ...options, userPassword: '' })).refusal).toBe(
      'password-missing',
    );
    expect(
      (await h.jobs.lockAll({ ...options, algorithm: 'aes-128', userPassword: '密码' })).refusal,
    ).toBe('password-not-encodable');
    expect(
      (await h.jobs.lockAll({ ...options, algorithm: 'aes-128', userPassword: 'x'.repeat(33) }))
        .refusal,
    ).toBe('password-too-long');
    expect(h.engine.calls.process).toEqual([]);
    // The form was not consulted, so it shows nothing.
    expect(h.lockForm.errors.value.password).toBeNull();
  });

  it('validates before it looks at the files', async () => {
    const h = lockHarness();
    expect((await h.jobs.lockAll()).refusal).toBe('invalid-form');
    h.fillLockForm();
    expect((await h.jobs.lockAll()).refusal).toBe('nothing-to-do');
  });
});

describe('lock: running', () => {
  it('encrypts with the settings of the form', async () => {
    const h = lockHarness();
    await h.add('plain.pdf');
    h.lockForm.setRevealed(true);
    h.lockForm.setPassword('open');
    h.lockForm.setSeparateOwner(true);
    h.lockForm.setOwnerPassword('boss');
    h.lockForm.setPermission('print', 'low');
    h.lockForm.setPermission('extract', false);
    h.lockForm.setEncryptMetadata(false);
    expect(await h.jobs.runPrimary()).toMatchObject({ started: true, done: 1 });
    expect(h.engine.calls.process).toEqual([
      {
        name: 'plain.pdf',
        password: '',
        operation: {
          kind: 'encrypt',
          options: {
            algorithm: 'aes-256',
            userPassword: 'open',
            ownerPassword: 'boss',
            permissions: { ...ALL_PERMISSIONS, print: 'low', extract: false },
            encryptMetadata: false,
          },
        },
        output: { streams: 'preserve', linearize: false, verify: true },
      },
    ]);
  });

  it('produces an output that really is encrypted as asked', async () => {
    const h = lockHarness();
    const [entry] = await h.add('plain.pdf');
    await h.jobs.lockAll({ ...options, ownerPassword: 'boss' });
    void h.jobs.save(entry!.id);
    const output = h.save.calls[0]!.files[0]!;
    expect(output.name).toBe('plain_locked.pdf');
    expect(await h.engine.inspect(output.blob)).toMatchObject({
      encrypted: true,
      access: 'locked',
      encryption: { algorithm: 'aes-256', keyBits: 256 },
    });
    expect((await h.engine.inspect(output.blob, NEW_PASSWORD)).access).toBe('user');
    expect((await h.engine.inspect(output.blob, 'boss')).access).toBe('owner');
  });

  it('handles a mixed batch', async () => {
    const h = lockHarness();
    await h.add('plain.pdf', 'owner-only.pdf', 'aes128.pdf', 'needs-password.pdf', 'damaged.pdf');
    h.jobs.setCurrentPassword(h.entry('aes128.pdf').id, DEMO_PASSWORD);
    expect(h.jobs.summary.value).toMatchObject({
      total: 5,
      actionable: 3,
      needPassword: 1,
      failed: 1,
      primary: { label: { key: 'action.lockCount', params: { count: 3 } }, enabled: true },
    });
    h.fillLockForm();
    const report = await h.jobs.lockAll();
    expect(report).toEqual({ started: true, done: 3, rejected: 0, failed: 0, cancelled: 0 });
    expect(h.states()).toEqual(['done', 'done', 'done', 'encrypted', 'error']);
    expect(h.engine.calls.process.map((call) => [call.name, call.password])).toEqual([
      ['plain.pdf', ''],
      // Opens without a password: none is sent.
      ['owner-only.pdf', ''],
      ['aes128.pdf', DEMO_PASSWORD],
    ]);
    expect(h.jobs.entries.value.slice(0, 3).map((entry) => entry.view.value.result!.name)).toEqual([
      'plain_locked.pdf',
      'owner-only_locked.pdf',
      'aes128_locked.pdf',
    ]);
    // The file that was skipped now says what it is waiting for.
    expect(h.view('needs-password.pdf').password!.error).toEqual({
      key: 'entry.currentPassword.required',
    });
    expect(h.jobs.summary.value).toMatchObject({
      phase: 'ready',
      done: 3,
      needPassword: 1,
      status: { key: 'status.nothingToLock' },
    });
  });

  it('re-encrypts an encrypted input with its current password and then forgets it', async () => {
    const h = lockHarness();
    await h.add('rc4.pdf');
    const entry = h.entry('rc4.pdf');
    h.jobs.setCurrentPassword(entry.id, DEMO_PASSWORD);
    h.fillLockForm();
    expect(await h.jobs.lockAll()).toMatchObject({ done: 1 });
    expect(entry.view.value).toMatchObject({
      state: 'done',
      algorithm: { label: { key: 'algorithm.chip.aes-256' }, outdated: false },
      password: null,
    });
    expect(entry.currentPassword.value).toBe('');
    expect(h.engine.calls.process[0]).toMatchObject({
      password: DEMO_PASSWORD,
      operation: { kind: 'encrypt', options: { userPassword: NEW_PASSWORD } },
    });
  });

  it('accepts the owner password as the current password', async () => {
    const h = lockHarness();
    await h.add('needs-password.pdf');
    h.jobs.setCurrentPassword(h.entry('needs-password.pdf').id, DEMO_OWNER_PASSWORD);
    h.fillLockForm();
    expect(await h.jobs.lockAll()).toMatchObject({ done: 1 });
  });

  it('flags a missing current password, and clears the flag when the user types', async () => {
    const h = lockHarness();
    await h.add('aes128.pdf');
    h.fillLockForm();
    expect(await h.jobs.lockAll()).toMatchObject({
      started: false,
      refusal: 'current-password-required',
    });
    const entry = h.entry('aes128.pdf');
    expect(entry.view.value).toMatchObject({
      state: 'encrypted',
      password: { error: { key: 'entry.currentPassword.required' } },
    });
    h.jobs.setCurrentPassword(entry.id, 'x');
    expect(entry.view.value.password!.error).toBeNull();
    expect(h.engine.calls.process).toEqual([]);
  });

  it('wrong current password: inline error, and no retry until it is corrected', async () => {
    const h = lockHarness();
    await h.add('aes128.pdf', 'plain.pdf');
    const entry = h.entry('aes128.pdf');
    h.jobs.setCurrentPassword(entry.id, 'wrong');
    h.fillLockForm();
    expect(await h.jobs.lockAll()).toMatchObject({ started: true, done: 1, rejected: 1 });
    expect(entry.view.value).toMatchObject({
      state: 'wrong-password',
      chip: { label: { key: 'chip.wrongPassword' }, tone: 'danger' },
      password: { kind: 'current', error: { key: 'entry.currentPassword.wrong' } },
    });
    expect(entry.currentPassword.value).toBe('wrong');
    expect(h.jobs.summary.value).toMatchObject({
      phase: 'ready',
      actionable: 0,
      needPassword: 1,
      primary: { enabled: false },
    });
    expect((await h.jobs.lockAll()).refusal).toBe('current-password-required');
    expect(h.engine.calls.process).toHaveLength(2);

    h.jobs.setCurrentPassword(entry.id, DEMO_PASSWORD);
    expect(entry.view.value).toMatchObject({ state: 'encrypted', password: { error: null } });
    expect(await h.jobs.lockAll()).toMatchObject({ done: 1 });
    expect(h.states()).toEqual(['done', 'done']);
  });

  it('keeps the new password until the list is cleared, so that it can still be copied', async () => {
    const h = lockHarness();
    await h.add('plain.pdf');
    const generated = h.lockForm.generate();
    await h.jobs.lockAll();
    expect(h.lockForm.password.value).toBe(generated);
    h.jobs.clear();
    expect(h.lockForm.password.value).toBe('');
    expect(h.lockForm.generated.value).toBe(false);
  });

  it('cancels and removes in the middle of a run', async () => {
    const h = lockHarness({ engine: { hold: 0.5 } });
    await h.add('plain.pdf', 'owner-only.pdf', 'crash.pdf');
    h.fillLockForm();
    const run = h.jobs.lockAll();
    await tick();
    h.jobs.cancel(h.entry('plain.pdf').id);
    h.jobs.remove(h.entry('crash.pdf').id);
    expect(h.states()).toEqual(['ready', 'processing']);
    h.engine.release();
    expect(await run).toMatchObject({ done: 1, cancelled: 2 });
    expect(h.states()).toEqual(['ready', 'done']);
  });

  it('gives outputs distinct names', async () => {
    const h = lockHarness();
    await h.jobs.addFiles(
      [createDemoFile('plain.pdf'), createDemoFile('plain.pdf', { lastModified: 3 })],
      'picker',
    );
    await h.jobs.settled();
    await h.jobs.lockAll(options);
    expect(h.jobs.entries.value.map((entry) => entry.view.value.result!.name)).toEqual([
      'plain_locked.pdf',
      'plain_locked (2).pdf',
    ]);
  });

  it('swaps the suffix when one of its own outputs comes back', async () => {
    const h = lockHarness();
    await h.jobs.addFiles([new File(['%PDF-1.7 plain'], 'report_unlocked.pdf')], 'picker');
    await h.jobs.settled();
    await h.jobs.lockAll(options);
    expect(h.view('report_unlocked.pdf').result!.name).toBe('report_locked.pdf');
  });
});

describe('the two modes side by side', () => {
  it('keeps the files and gives each mode its own view of them', async () => {
    const h = createHarness();
    await h.add('needs-password.pdf', 'plain.pdf', 'owner-only.pdf');
    expect(h.states()).toEqual(['needs-password', 'not-encrypted', 'restricted']);
    h.mode.value = 'lock';
    expect(h.states()).toEqual(['encrypted', 'ready', 'encrypted']);
    expect(h.jobs.entries.value).toHaveLength(3);
    expect(h.jobs.summary.value).toMatchObject({ mode: 'lock', actionable: 2, needPassword: 1 });
    h.mode.value = 'unlock';
    expect(h.states()).toEqual(['needs-password', 'not-encrypted', 'restricted']);
  });

  it('keeps a result in the mode that produced it', async () => {
    const h = createHarness();
    await h.add('owner-only.pdf');
    const entry = h.entry('owner-only.pdf');
    await h.jobs.unlockAll();
    expect(entry.view.value.state).toBe('done');
    expect(entry.progress.value).toBe(1);

    h.mode.value = 'lock';
    expect(entry.view.value).toMatchObject({ state: 'encrypted', result: null, mode: 'lock' });
    expect(entry.progress.value).toBe(0);
    expect(h.jobs.summary.value).toMatchObject({ done: 0, results: { count: 0 } });

    h.fillLockForm();
    await h.jobs.lockAll();
    expect(entry.view.value.result!.name).toBe('owner-only_locked.pdf');

    h.mode.value = 'unlock';
    expect(entry.view.value.result!.name).toBe('owner-only_unlocked.pdf');
    expect(h.jobs.summary.value.results.count).toBe(1);
  });

  it('acts on the current mode only: save all, redo, cancel', async () => {
    const h = createHarness({ engine: { hold: 0.5 } });
    await h.add('owner-only.pdf');
    const entry = h.entry('owner-only.pdf');
    const unlocking = h.jobs.unlockAll();
    await tick();

    h.mode.value = 'lock';
    expect(entry.view.value.state).toBe('encrypted');
    expect(h.jobs.summary.value).toMatchObject({ phase: 'ready', canCancelAll: false });
    h.jobs.cancelAll();
    h.jobs.cancel(entry.id);
    h.engine.release();
    expect(await unlocking).toMatchObject({ done: 1, cancelled: 0 });

    await h.jobs.saveAll();
    expect(h.saved()).toEqual([]);
    h.jobs.redo(entry.id);
    h.mode.value = 'unlock';
    expect(entry.view.value.state).toBe('done');
    await h.jobs.saveAll();
    expect(h.saved()).toEqual([{ via: 'saveFile', names: ['owner-only_unlocked.pdf'] }]);
  });

  it('removing a file stops what both modes are doing with it', async () => {
    const h = createHarness({ engine: { hold: 0.5 } });
    await h.add('owner-only.pdf');
    const unlocking = h.jobs.unlockAll();
    h.mode.value = 'lock';
    h.fillLockForm();
    const locking = h.jobs.lockAll();
    await tick();
    expect(h.engine.held).toBe(2);
    h.jobs.remove(h.entry('owner-only.pdf').id);
    expect(await unlocking).toMatchObject({ cancelled: 1 });
    expect(await locking).toMatchObject({ cancelled: 1 });
    expect(h.engine.held).toBe(0);
  });
});
