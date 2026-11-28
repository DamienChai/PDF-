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
      rejected: 1,
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

describe('lock: one set of settings for the whole list', () => {
  const OTHER_PASSWORD = 'another-Passw0rd?';

  /** Which of the two passwords open the result of a file. */
  async function opens(h: ReturnType<typeof lockHarness>, name: string) {
    // The way out of the controller for a result is saving it.
    await h.jobs.save(h.entry(name).id);
    const output = h.save.calls.at(-1)!.files[0]!.blob;
    return {
      first: (await h.engine.inspect(output, NEW_PASSWORD)).access !== 'locked',
      second: (await h.engine.inspect(output, OTHER_PASSWORD)).access !== 'locked',
    };
  }

  it('remembers what the results were made with, whatever the form holds later', async () => {
    const h = lockHarness();
    await h.add('plain.pdf');
    expect(h.jobs.lockApplied.value).toBeNull();
    h.fillLockForm();
    await h.jobs.lockAll();
    expect(h.jobs.lockApplied.value).toEqual({
      summary: { list: [{ key: 'algorithm.chip.aes-256' }] },
      passwordLabel: { key: 'lock.password.label' },
      password: NEW_PASSWORD,
    });
    // No result carries a password: they refer to the settings by number.
    expect(JSON.stringify(h.view('plain.pdf'))).not.toContain(NEW_PASSWORD);

    h.lockForm.setPassword('typed-afterwards');
    h.lockForm.setAlgorithm('aes-128');
    expect(h.jobs.lockApplied.value).toMatchObject({
      summary: { list: [{ key: 'algorithm.chip.aes-256' }] },
      password: NEW_PASSWORD,
    });
    // Everything is finished: there is no form to submit other settings with.
    expect(h.jobs.summary.value).toMatchObject({ phase: 'finished', primary: null, relock: 0 });
  });

  it('describes a separate permissions password and restrictions as they were applied', async () => {
    const h = lockHarness();
    await h.add('plain.pdf');
    h.lockForm.setSeparateOwner(true);
    h.lockForm.setOwnerPassword('owner-Passw0rd');
    h.lockForm.setPermission('print', 'none');
    h.lockForm.setEncryptMetadata(false);
    await h.jobs.lockAll();
    expect(h.jobs.lockApplied.value).toEqual({
      summary: {
        list: [
          { key: 'algorithm.chip.aes-256' },
          { key: 'lock.summary.restricted' },
          { key: 'lock.summary.metadataClear' },
        ],
      },
      passwordLabel: { key: 'lock.password.openLabel' },
      // Opens without a password.
      password: '',
    });
  });

  it('a file added after a run, same settings: only the new file is locked', async () => {
    const h = lockHarness();
    await h.add('plain.pdf');
    h.fillLockForm();
    await h.jobs.lockAll();
    await h.add('owner-only.pdf');
    expect(h.jobs.summary.value).toMatchObject({
      phase: 'ready',
      relock: 0,
      primary: { label: { key: 'action.lock' }, count: 1 },
    });
    expect(await h.jobs.lockAll()).toMatchObject({ done: 1 });
    expect(h.engine.calls.process.map((call) => call.name)).toEqual([
      'plain.pdf',
      'owner-only.pdf',
    ]);
    expect(h.jobs.lockApplied.value).toMatchObject({ password: NEW_PASSWORD });
    expect(await opens(h, 'plain.pdf')).toEqual({ first: true, second: false });
    expect(await opens(h, 'owner-only.pdf')).toEqual({ first: true, second: false });
  });

  it('a file added after a run, other password: every result is made again', async () => {
    const h = lockHarness();
    await h.add('plain.pdf');
    h.fillLockForm();
    await h.jobs.lockAll();
    await h.jobs.save(h.entry('plain.pdf').id);
    await h.add('owner-only.pdf');

    // The button and the summary follow the form as it is typed in.
    h.lockForm.setPassword(OTHER_PASSWORD);
    expect(h.jobs.summary.value).toMatchObject({
      phase: 'ready',
      actionable: 2,
      relock: 1,
      done: 1,
      primary: { label: { key: 'action.lockCount', params: { count: 2 } }, count: 2 },
    });
    h.lockForm.setPassword(NEW_PASSWORD);
    expect(h.jobs.summary.value).toMatchObject({ relock: 0, primary: { count: 1 } });

    h.fillLockForm(OTHER_PASSWORD);
    expect(await h.jobs.lockAll()).toEqual({
      started: true,
      done: 2,
      rejected: 0,
      failed: 0,
      cancelled: 0,
    });
    // From the input, not from the first result.
    expect(h.engine.calls.process.map((call) => [call.name, call.password])).toEqual([
      ['plain.pdf', ''],
      ['plain.pdf', ''],
      ['owner-only.pdf', ''],
    ]);
    expect(h.states()).toEqual(['done', 'done']);
    expect(h.jobs.lockApplied.value).toMatchObject({ password: OTHER_PASSWORD });
    // A new output under the old name; that the first one was saved says nothing about it.
    expect(h.view('plain.pdf').result).toMatchObject({ name: 'plain_locked.pdf', saved: false });
    expect(h.view('owner-only.pdf').result).toMatchObject({ name: 'owner-only_locked.pdf' });
    expect(h.jobs.summary.value).toMatchObject({
      phase: 'finished',
      status: { key: 'status.locked', params: { count: 2 } },
      relock: 0,
    });
    expect(await opens(h, 'plain.pdf')).toEqual({ first: false, second: true });
    expect(await opens(h, 'owner-only.pdf')).toEqual({ first: false, second: true });
  });

  it('a file that waited for its current password, other password meanwhile', async () => {
    const h = lockHarness();
    await h.add('plain.pdf', 'aes128.pdf');
    h.fillLockForm();
    expect(await h.jobs.lockAll()).toMatchObject({ done: 1 });
    expect(h.states()).toEqual(['done', 'encrypted']);

    h.fillLockForm(OTHER_PASSWORD);
    // Nothing but the finished file could be locked now, and it would be.
    expect(h.jobs.summary.value).toMatchObject({
      relock: 1,
      needPassword: 1,
      primary: { count: 1, enabled: true },
      status: null,
    });
    h.jobs.setCurrentPassword(h.entry('aes128.pdf').id, DEMO_PASSWORD);
    expect(h.jobs.summary.value.primary).toMatchObject({
      label: { key: 'action.lockCount', params: { count: 2 } },
    });
    expect(await h.jobs.lockAll()).toMatchObject({ done: 2 });
    expect(await opens(h, 'plain.pdf')).toEqual({ first: false, second: true });
    expect(await opens(h, 'aes128.pdf')).toEqual({ first: false, second: true });
  });

  it('other options count as other settings, not only another password', async () => {
    const h = lockHarness();
    await h.add('plain.pdf');
    h.fillLockForm('simple-pass');
    await h.jobs.lockAll();
    await h.add('owner-only.pdf');
    h.lockForm.setAlgorithm('aes-128');
    expect(h.jobs.summary.value.relock).toBe(1);
    await h.jobs.lockAll();
    for (const name of ['plain.pdf', 'owner-only.pdf']) {
      expect(h.view(name).algorithm).toMatchObject({ label: { key: 'algorithm.chip.aes-128' } });
    }
    expect(h.jobs.lockApplied.value?.summary).toEqual({
      list: [{ key: 'algorithm.chip.aes-128' }],
    });
  });

  it('opens an already protected input again without asking twice, and without showing its password', async () => {
    const h = lockHarness();
    await h.add('aes128.pdf');
    const entry = h.entry('aes128.pdf');
    h.jobs.setCurrentPassword(entry.id, DEMO_PASSWORD);
    h.fillLockForm();
    await h.jobs.lockAll();
    expect(entry.currentPassword.value).toBe('');

    await h.add('plain.pdf');
    h.fillLockForm(OTHER_PASSWORD);
    expect(await h.jobs.lockAll()).toMatchObject({ done: 2 });
    expect(h.engine.calls.process.map((call) => [call.name, call.password])).toEqual([
      ['aes128.pdf', DEMO_PASSWORD],
      ['aes128.pdf', DEMO_PASSWORD],
      ['plain.pdf', ''],
    ]);
    expect(entry.currentPassword.value).toBe('');
    expect(await opens(h, 'aes128.pdf')).toEqual({ first: false, second: true });

    // Kept for the result only: once that is discarded the card asks again.
    h.jobs.redo(entry.id);
    expect(entry.view.value).toMatchObject({ state: 'encrypted', password: { kind: 'current' } });
    expect(entry.currentPassword.value).toBe('');
    expect(await h.jobs.lockAll()).toMatchObject({
      started: false,
      refusal: 'current-password-required',
    });
  });

  it('applies to settings passed in directly as well', async () => {
    const h = lockHarness();
    await h.add('plain.pdf', 'owner-only.pdf');
    await h.jobs.lockAll(options);
    await h.jobs.lockAll(options);
    expect(h.engine.calls.process).toHaveLength(2);
    expect(await h.jobs.lockAll({ ...options, userPassword: OTHER_PASSWORD })).toMatchObject({
      done: 2,
    });
    expect(h.engine.calls.process).toHaveLength(4);
    expect(h.jobs.lockApplied.value).toMatchObject({ password: OTHER_PASSWORD });
    expect(await opens(h, 'plain.pdf')).toEqual({ first: false, second: true });
  });

  it('restarts what is still running when other settings are submitted', async () => {
    const h = lockHarness({ engine: { hold: 0.5 } });
    await h.add('plain.pdf');
    const first = h.jobs.lockAll(options);
    await tick();
    const second = h.jobs.lockAll({ ...options, userPassword: OTHER_PASSWORD });
    await tick();
    expect(h.states()).toEqual(['processing']);
    h.engine.release();
    expect(await first).toMatchObject({ done: 0, cancelled: 1 });
    expect(await second).toMatchObject({ done: 1 });
    expect(h.jobs.lockApplied.value).toMatchObject({ password: OTHER_PASSWORD });
    expect(await opens(h, 'plain.pdf')).toEqual({ first: false, second: true });
  });

  it('forgets the applied settings with the last result made with them', async () => {
    const h = lockHarness({ engine: { hold: 0.5 } });
    await h.add('plain.pdf', 'owner-only.pdf');
    h.fillLockForm();
    const run = h.jobs.lockAll();
    await tick();
    expect(h.jobs.lockApplied.value).toMatchObject({ password: NEW_PASSWORD });
    h.jobs.cancelAll();
    expect(h.jobs.lockApplied.value).toBeNull();
    await run;

    h.engine.release();
    await h.jobs.lockAll();
    expect(h.jobs.lockApplied.value).not.toBeNull();
    h.jobs.redo(h.entry('plain.pdf').id);
    expect(h.jobs.lockApplied.value).not.toBeNull();
    h.jobs.remove(h.entry('owner-only.pdf').id);
    expect(h.jobs.lockApplied.value).toBeNull();
  });

  it('forgets them when every file of the run failed', async () => {
    const h = lockHarness();
    await h.add('crash.pdf');
    h.fillLockForm();
    expect(await h.jobs.lockAll()).toMatchObject({ failed: 1 });
    expect(h.jobs.lockApplied.value).toBeNull();
  });

  it('copies the password the results were made with', async () => {
    const copied: string[] = [];
    const h = lockHarness({
      clipboard: { writeText: (text) => Promise.resolve(void copied.push(text)) },
    });
    await h.add('plain.pdf');
    expect(await h.jobs.copyLockPassword()).toBe(false);
    h.fillLockForm();
    await h.jobs.lockAll();
    h.lockForm.setPassword('typed-afterwards');
    expect(await h.jobs.copyLockPassword()).toBe(true);
    expect(copied).toEqual([NEW_PASSWORD]);
    expect(h.toastKeys()).toEqual(['toast.passwordCopied']);
  });
});

describe('lock: a result made with other settings than the form holds', () => {
  const OTHER_PASSWORD = 'another-Passw0rd?';

  it('is withheld until it has been locked again, and says so', async () => {
    const h = lockHarness();
    await h.add('plain.pdf');
    h.fillLockForm();
    await h.jobs.lockAll();
    await h.add('aes128.pdf');
    const first = h.entry('plain.pdf');
    // The form still holds what the result was made with.
    expect(first.view.value).toMatchObject({
      state: 'done',
      result: { name: 'plain_locked.pdf', withheld: false },
    });

    h.lockForm.setPassword(OTHER_PASSWORD);
    expect(h.jobs.summary.value).toMatchObject({ phase: 'ready', done: 1, relock: 1 });
    expect(first.view.value).toMatchObject({
      state: 'done',
      chip: { label: { key: 'chip.locked' } },
      result: { name: 'plain_locked.pdf', withheld: true },
      canRedo: true,
    });
    // No way out for a file that the password on screen does not open.
    await h.jobs.save(first.id);
    await h.jobs.share(first.id);
    h.jobs.open(first.id);
    await h.jobs.saveAll();
    await h.jobs.shareAll();
    expect(h.saved()).toEqual([]);
    expect(h.jobs.unsavedWork.value).toBe(true);

    // Back to the settings it was made with: on offer again.
    h.lockForm.setPassword(NEW_PASSWORD);
    expect(h.jobs.summary.value.relock).toBe(0);
    expect(first.view.value.result).toMatchObject({ name: 'plain_locked.pdf', withheld: false });
    await h.jobs.save(first.id);
    expect(h.saved()).toEqual([{ via: 'saveFile', names: ['plain_locked.pdf'] }]);
  });

  it('is withheld while an added file is still being read', async () => {
    const h = lockHarness();
    await h.add('plain.pdf');
    h.fillLockForm();
    await h.jobs.lockAll();
    h.engine.setHold('inspect');
    await h.jobs.addFiles([createDemoFile('owner-only.pdf')], 'picker');
    expect(h.states()).toEqual(['done', 'analysing']);
    expect(h.view('plain.pdf').result).toMatchObject({ withheld: false });

    h.lockForm.setPassword(OTHER_PASSWORD);
    expect(h.jobs.summary.value).toMatchObject({ phase: 'analysing', relock: 1, primary: null });
    expect(h.view('plain.pdf').result).toMatchObject({ withheld: true });
    await h.jobs.save(h.entry('plain.pdf').id);
    expect(h.saved()).toEqual([]);

    h.engine.release();
    await h.jobs.settled();
    expect(h.jobs.summary.value).toMatchObject({
      phase: 'ready',
      relock: 1,
      primary: { count: 2, enabled: true },
    });
  });

  it('is on offer again when nothing is left to submit the form for', async () => {
    const h = lockHarness();
    await h.add('plain.pdf');
    h.fillLockForm();
    await h.jobs.lockAll();
    await h.add('owner-only.pdf');
    h.lockForm.setPassword(OTHER_PASSWORD);
    expect(h.view('plain.pdf').result).toMatchObject({ withheld: true });

    // The result panel takes the form's place and shows what the result was made with.
    h.jobs.remove(h.entry('owner-only.pdf').id);
    expect(h.jobs.summary.value).toMatchObject({ phase: 'finished', relock: 0 });
    expect(h.jobs.lockApplied.value).toMatchObject({ password: NEW_PASSWORD });
    expect(h.view('plain.pdf').result).toMatchObject({ name: 'plain_locked.pdf', withheld: false });
  });
});

describe('lock: a result stays until its replacement is finished', () => {
  const OTHER_PASSWORD = 'another-Passw0rd?';

  /** Two finished files (one of them was protected before) and a third one, other settings. */
  async function relocking(engine: { hold: number | null } = { hold: null }) {
    const h = lockHarness({ engine });
    await h.add('plain.pdf', 'aes128.pdf');
    h.jobs.setCurrentPassword(h.entry('aes128.pdf').id, DEMO_PASSWORD);
    h.fillLockForm();
    expect(await h.jobs.lockAll()).toMatchObject({ done: 2 });
    await h.add('owner-only.pdf');
    h.fillLockForm(OTHER_PASSWORD);
    return h;
  }

  it('cancelling the run puts back what was there', async () => {
    const h = await relocking();
    h.engine.setHold(0.5);
    const run = h.jobs.lockAll();
    await tick();
    expect(h.states()).toEqual(['processing', 'processing', 'processing']);
    expect(h.jobs.unsavedWork.value).toBe(true);

    h.jobs.cancelAll();
    expect(await run).toMatchObject({ done: 0, cancelled: 3 });
    expect(h.states()).toEqual(['done', 'done', 'encrypted']);
    expect(h.jobs.unsavedWork.value).toBe(true);
    expect(h.entry('plain.pdf').progress.value).toBe(1);
    // As before the run: made with the first settings, to be locked again with the form's.
    expect(h.jobs.lockApplied.value).toMatchObject({ password: NEW_PASSWORD });
    expect(h.jobs.summary.value).toMatchObject({
      phase: 'ready',
      relock: 2,
      primary: { label: { key: 'action.lockCount', params: { count: 3 } } },
    });
    // The protected input is not asked for its password again.
    expect(h.view('aes128.pdf')).toMatchObject({ state: 'done', password: null });

    h.lockForm.setPassword(NEW_PASSWORD);
    await h.jobs.save(h.entry('aes128.pdf').id);
    const output = h.save.calls.at(-1)!.files[0]!.blob;
    expect((await h.engine.inspect(output, NEW_PASSWORD)).access).not.toBe('locked');

    h.engine.release();
    h.fillLockForm(OTHER_PASSWORD);
    expect(await h.jobs.lockAll()).toMatchObject({ done: 3 });
    expect(h.engine.calls.process.at(-2)).toMatchObject({
      name: 'aes128.pdf',
      password: DEMO_PASSWORD,
    });
    expect(h.jobs.lockApplied.value).toMatchObject({ password: OTHER_PASSWORD });
  });

  it('cancelling one file puts its result back, to be locked again', async () => {
    const h = await relocking();
    h.engine.setHold(0.5);
    const run = h.jobs.lockAll();
    await tick();
    h.jobs.cancel(h.entry('plain.pdf').id);
    h.engine.release();
    expect(await run).toMatchObject({ done: 2, cancelled: 1 });
    expect(h.states()).toEqual(['done', 'done', 'done']);

    // Two sets of settings side by side: the form stays, and only its results are on offer.
    expect(h.jobs.lockApplied.value).toBeNull();
    expect(h.jobs.summary.value).toMatchObject({
      phase: 'ready',
      relock: 1,
      primary: { label: { key: 'action.lock' }, count: 1, enabled: true },
    });
    expect(h.view('plain.pdf').result).toMatchObject({ withheld: true });
    expect(h.view('aes128.pdf').result).toMatchObject({ withheld: false });
    await h.jobs.saveAll();
    expect(h.saved()).toEqual([
      {
        via: 'saveAsZip',
        names: ['aes128_locked.pdf', 'owner-only_locked.pdf'],
        zipName: 'archive-lock.zip',
      },
    ]);

    // Whichever settings the form holds, the results made with the others are locked again.
    h.lockForm.setPassword(NEW_PASSWORD);
    expect(h.jobs.summary.value).toMatchObject({ relock: 2, primary: { count: 2 } });
    expect(h.view('plain.pdf').result).toMatchObject({ withheld: false });
    expect(h.view('aes128.pdf').result).toMatchObject({ withheld: true });

    h.fillLockForm(OTHER_PASSWORD);
    expect(await h.jobs.lockAll()).toMatchObject({ done: 1 });
    expect(h.engine.calls.process.at(-1)).toMatchObject({ name: 'plain.pdf' });
    expect(h.jobs.summary.value).toMatchObject({ phase: 'finished', relock: 0 });
    expect(h.jobs.lockApplied.value).toMatchObject({ password: OTHER_PASSWORD });
  });

  it('a run that fails keeps it aside, and "retry" brings it back', async () => {
    const h = await relocking();
    h.jobs.remove(h.entry('owner-only.pdf').id);
    await h.add('plain-2.pdf');
    h.fillLockForm(OTHER_PASSWORD);
    h.engine.setUnavailable(true);
    expect(await h.jobs.lockAll()).toMatchObject({ done: 0, failed: 3 });
    expect(h.states()).toEqual(['error', 'error', 'error']);
    // Still in the page only, although no card shows it.
    expect(h.jobs.unsavedWork.value).toBe(true);
    expect(h.jobs.lockApplied.value).toBeNull();

    h.engine.setUnavailable(false);
    const protectedFile = h.entry('aes128.pdf');
    h.jobs.retry(protectedFile.id);
    h.jobs.retry(h.entry('plain.pdf').id);
    h.jobs.retry(h.entry('plain-2.pdf').id);
    expect(h.states()).toEqual(['done', 'done', 'ready']);
    expect(protectedFile.view.value).toMatchObject({
      result: { withheld: true },
      password: null,
      error: null,
    });
    expect(h.jobs.lockApplied.value).toMatchObject({ password: NEW_PASSWORD });

    expect(await h.jobs.lockAll()).toMatchObject({ done: 3 });
    expect(
      h.engine.calls.process.filter((call) => call.name === 'aes128.pdf').at(-1),
    ).toMatchObject({ password: DEMO_PASSWORD });
    expect(h.jobs.lockApplied.value).toMatchObject({ password: OTHER_PASSWORD });
  });

  it('removing the file drops what was kept aside', async () => {
    const h = await relocking();
    h.engine.setUnavailable(true);
    await h.jobs.lockAll();
    expect(h.jobs.unsavedWork.value).toBe(true);
    h.jobs.remove(h.entry('plain.pdf').id);
    h.jobs.remove(h.entry('aes128.pdf').id);
    expect(h.jobs.unsavedWork.value).toBe(false);
    expect(h.jobs.entries.value).toHaveLength(1);
  });

  it('other settings submitted during the run: the first result is still the one that comes back', async () => {
    const h = await relocking({ hold: null });
    h.engine.setHold(0.5);
    const second = h.jobs.lockAll();
    await tick();
    h.fillLockForm('third-Passw0rd#');
    const third = h.jobs.lockAll();
    await tick();
    h.jobs.cancelAll();
    expect(await second).toMatchObject({ done: 0 });
    expect(await third).toMatchObject({ done: 0, cancelled: 3 });
    expect(h.states()).toEqual(['done', 'done', 'encrypted']);
    expect(h.jobs.lockApplied.value).toMatchObject({ password: NEW_PASSWORD });
  });

  it('auto-save does not deliver a result that came back: it was made with other settings', async () => {
    // Unsaved results from before auto-save was switched on, then the run is cancelled.
    const h = await relocking();
    h.settings.value = { ...h.settings.value, autoSave: true };
    h.engine.setHold(0.5);
    const run = h.jobs.lockAll();
    await tick();
    h.jobs.cancelAll();
    h.engine.release();
    expect(await run).toMatchObject({ done: 0, cancelled: 3 });
    await h.jobs.settled();
    expect(h.saved()).toEqual([]);
    expect(h.toastKeys()).toEqual([]);
    expect(h.view('plain.pdf').result).toMatchObject({ withheld: true, saved: false });
    expect(h.view('aes128.pdf').result).toMatchObject({ withheld: true, saved: false });
    expect(h.jobs.unsavedWork.value).toBe(true);
  });

  it('auto-save delivers what the run made, and not the result of a file that was cancelled', async () => {
    const h = await relocking();
    h.settings.value = { ...h.settings.value, autoSave: true };
    h.engine.setHold(0.5);
    const run = h.jobs.lockAll();
    await tick();
    h.jobs.cancel(h.entry('plain.pdf').id);
    // The run ends while the other mode is on screen: nothing is withheld there, and it is
    // still not handed out.
    h.mode.value = 'unlock';
    h.engine.release();
    expect(await run).toMatchObject({ done: 2, cancelled: 1 });
    await h.jobs.settled();
    h.mode.value = 'lock';
    expect(h.save.zips).toEqual([['aes128_locked.pdf', 'owner-only_locked.pdf']]);
    expect(h.saved()).toEqual([{ via: 'downloadFile', names: ['archive-lock.zip'] }]);
    expect(h.view('plain.pdf').result).toMatchObject({ withheld: true, saved: false });
    expect(h.view('aes128.pdf').result).toMatchObject({ withheld: false, saved: true });
    // Everything that was delivered opens with the password on screen.
    for (const file of h.save.calls.flatMap((call) => call.files)) {
      if (!file.name.endsWith('.pdf')) continue;
      expect((await h.engine.inspect(file.blob, OTHER_PASSWORD)).access).not.toBe('locked');
    }
  });

  it('gives a kept result its name back, whatever was locked meanwhile', async () => {
    const h = lockHarness();
    await h.add('plain.pdf');
    h.fillLockForm();
    await h.jobs.lockAll();
    await h.add('owner-only.pdf');
    h.fillLockForm(OTHER_PASSWORD);
    h.engine.setUnavailable(true);
    await h.jobs.lockAll();
    h.engine.setUnavailable(false);
    // A second file of the same name is locked while the first one shows its error.
    await h.jobs.addFiles([new File(['%PDF-1.7 another'], 'plain.pdf')], 'picker');
    await h.jobs.settled();
    h.jobs.retry(h.entry('owner-only.pdf').id);
    expect(await h.jobs.lockAll()).toMatchObject({ done: 2 });
    h.jobs.retry(h.jobs.entries.value[0]!.id);
    h.lockForm.setPassword(NEW_PASSWORD);
    const offered = (): (string | null)[] =>
      h.jobs.entries.value.map((entry) => {
        const { result } = entry.view.value;
        return result && !result.withheld ? result.name : null;
      });
    expect(offered()).toEqual(['plain_locked.pdf', null, null]);
    h.lockForm.setPassword(OTHER_PASSWORD);
    expect(offered()).toEqual([null, 'owner-only_locked.pdf', 'plain_locked (2).pdf']);
    // Withheld or not, no two results share a name.
    expect(h.jobs.entries.value.map((entry) => entry.view.value.result?.name)).toEqual([
      'plain_locked.pdf',
      'owner-only_locked.pdf',
      'plain_locked (2).pdf',
    ]);
  });
});

describe('lock: passwords go with the last file', () => {
  it('removing the last file clears the form as "clear" does', async () => {
    const h = lockHarness();
    await h.add('plain.pdf', 'owner-only.pdf');
    const generated = h.lockForm.generate();
    h.lockForm.setSeparateOwner(true);
    h.lockForm.setOwnerPassword('owner-Passw0rd');
    h.lockForm.setOwnerRevealed(true);
    await h.jobs.lockAll();
    expect(h.lockForm.revealed.value).toBe(true);

    h.jobs.remove(h.entry('plain.pdf').id);
    expect(h.lockForm.password.value).toBe(generated);
    h.jobs.remove(h.entry('owner-only.pdf').id);
    expect(h.jobs.summary.value.phase).toBe('empty');
    expect([
      h.lockForm.password.value,
      h.lockForm.confirmation.value,
      h.lockForm.ownerPassword.value,
    ]).toEqual(['', '', '']);
    expect(h.lockForm.revealed.value).toBe(false);
    expect(h.lockForm.ownerRevealed.value).toBe(false);
    expect(h.lockForm.generated.value).toBe(false);
    expect(h.jobs.lockApplied.value).toBeNull();
    // The options are settings, not secrets.
    expect(h.lockForm.separateOwner.value).toBe(true);

    // The next file meets an empty form.
    await h.add('plain.pdf');
    expect(h.lockForm.password.value).toBe('');
    expect((await h.jobs.lockAll()).refusal).toBe('invalid-form');
  });

  it('removing the last file in Unlock mode clears it too', async () => {
    const h = createHarness();
    await h.add('needs-password.pdf');
    h.fillLockForm();
    h.jobs.setUnlockPassword('typed');
    h.jobs.remove(h.entry('needs-password.pdf').id);
    expect(h.lockForm.password.value).toBe('');
    expect(h.jobs.unlockPassword.value).toBe('');
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
