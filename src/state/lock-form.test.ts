import { effect } from '@preact/signals';
import { describe, expect, it, vi } from 'vitest';
import { checkNewPasswords } from '../engine/passwords';
import { ALL_PERMISSIONS } from '../engine/types';
import type { MessageKey } from '../i18n';
import { GENERATED_PASSWORD_LENGTH, createLockForm, type LockFormErrors } from './lock-form';
import { createToastQueue } from './toasts';

function setup(clipboard?: Pick<Clipboard, 'writeText'> | null) {
  const toasts = createToastQueue();
  const form = createLockForm({
    toasts,
    clipboard: () => (clipboard === null ? undefined : clipboard),
  });
  const toastKeys = (): string[] => toasts.toasts.value.map((toast) => toast.message.key);
  return { form, toasts, toastKeys };
}

function keys(errors: LockFormErrors): Record<string, MessageKey | null> {
  return {
    password: errors.password?.key ?? null,
    confirmation: errors.confirmation?.key ?? null,
    ownerPassword: errors.ownerPassword?.key ?? null,
  };
}

const NONE = { password: null, confirmation: null, ownerPassword: null };

describe('lock form: defaults', () => {
  it('starts empty, hidden, with the recommended options', () => {
    const { form } = setup();
    expect(form.password.value).toBe('');
    expect(form.revealed.value).toBe(false);
    expect(form.confirmationNeeded.value).toBe(true);
    expect(form.algorithm.value).toBe('aes-256');
    expect(form.separateOwner.value).toBe(false);
    expect(form.encryptMetadata.value).toBe(true);
    expect(form.advancedOpen.value).toBe(false);
    expect(form.permissions.value).toEqual({
      print: 'full',
      extract: true,
      modify: true,
      annotate: true,
      assemble: true,
    });
    expect(form.valid.value).toBe(false);
  });

  it('shows no errors before the user did anything', () => {
    const { form } = setup();
    expect(keys(form.errors.value)).toEqual(NONE);
    expect(keys(form.problems.value)).toEqual({ ...NONE, password: 'lock.error.required' });
  });
});

describe('lock form: confirmation', () => {
  it('is valid when password and confirmation match', () => {
    const { form } = setup();
    form.setPassword('correct horse');
    form.setConfirmation('correct horse');
    expect(form.valid.value).toBe(true);
    expect(keys(form.errors.value)).toEqual(NONE);
  });

  it('stays quiet while the confirmation is still being typed correctly', () => {
    const { form } = setup();
    form.setPassword('secret-1');
    for (const partial of ['s', 'sec', 'secret-']) {
      form.setConfirmation(partial);
      expect(form.errors.value.confirmation, partial).toBeNull();
      expect(form.valid.value).toBe(false);
    }
  });

  it('reports a mismatch as soon as a wrong character is typed', () => {
    const { form } = setup();
    form.setPassword('secret-1');
    form.setConfirmation('sex');
    expect(form.errors.value.confirmation?.key).toBe('lock.error.mismatch');
    form.setConfirmation('se');
    expect(form.errors.value.confirmation).toBeNull();
  });

  it('reports an unfinished confirmation once the field was left', () => {
    const { form } = setup();
    form.setPassword('secret-1');
    form.setConfirmation('secret');
    form.touch('confirmation');
    expect(form.errors.value.confirmation?.key).toBe('lock.error.mismatch');
    // Typing again starts a new attempt.
    form.setConfirmation('secret-');
    expect(form.errors.value.confirmation).toBeNull();
    form.setConfirmation('secret-1');
    form.touch('confirmation');
    expect(form.errors.value.confirmation).toBeNull();
  });

  it('does not complain about an empty confirmation before a submit attempt', () => {
    const { form } = setup();
    form.setPassword('secret-1');
    form.touch('confirmation');
    expect(form.errors.value.confirmation).toBeNull();
    expect(form.problems.value.confirmation?.key).toBe('lock.error.confirmRequired');
  });

  it('is skipped while the password is shown', () => {
    const { form } = setup();
    form.setPassword('secret-1');
    form.setRevealed(true);
    expect(form.confirmationNeeded.value).toBe(false);
    expect(form.valid.value).toBe(true);
    // Hiding it again asks for the confirmation after all.
    form.setRevealed(false);
    expect(form.valid.value).toBe(false);
    expect(form.problems.value.confirmation?.key).toBe('lock.error.confirmRequired');
  });

  it('notices when the password changes under a finished confirmation', () => {
    const { form } = setup();
    form.setPassword('secret-1');
    form.setConfirmation('secret-1');
    form.setPassword('secret-2');
    expect(form.valid.value).toBe(false);
    expect(form.errors.value.confirmation?.key).toBe('lock.error.mismatch');
  });
});

describe('lock form: Enter in the password field', () => {
  it('moves on to the confirmation while that is still to be typed', () => {
    const { form } = setup();
    expect(form.passwordEnter.value).toBe('next');
    form.setPassword('correct horse');
    expect(form.passwordEnter.value).toBe('next');
    // Moving on is no submit attempt: nothing is reported as missing.
    expect(keys(form.errors.value)).toEqual(NONE);
  });

  it('submits once the confirmation is typed, or not needed', () => {
    const { form } = setup();
    form.setPassword('correct horse');
    form.setConfirmation('correct h');
    expect(form.passwordEnter.value).toBe('go');
    form.setConfirmation('');
    expect(form.passwordEnter.value).toBe('next');
    form.setRevealed(true);
    expect(form.confirmationNeeded.value).toBe(false);
    expect(form.passwordEnter.value).toBe('go');
  });

  it('submits a generated password, which needs no confirmation', () => {
    const { form } = setup();
    form.generate();
    expect(form.passwordEnter.value).toBe('go');
    form.setRevealed(false);
    expect(form.passwordEnter.value).toBe('go');
  });
});

describe('lock form: submit', () => {
  it('rejects an empty form and makes every problem visible', () => {
    const { form } = setup();
    const result = form.submit();
    expect(result).toMatchObject({ ok: false, field: 'password' });
    expect(keys(form.errors.value)).toEqual({ ...NONE, password: 'lock.error.required' });
  });

  it('names the first invalid field', () => {
    const { form } = setup();
    form.setPassword('secret-1');
    expect(form.submit()).toMatchObject({ ok: false, field: 'confirmation' });
    expect(form.errors.value.confirmation?.key).toBe('lock.error.confirmRequired');
    form.setConfirmation('secret-1');
    form.setSeparateOwner(true);
    expect(form.submit()).toMatchObject({ ok: false, field: 'ownerPassword' });
    expect(form.errors.value.ownerPassword?.key).toBe('lock.error.ownerRequired');
  });

  it('keeps errors live after a failed attempt and clears them as they are fixed', () => {
    const { form } = setup();
    form.submit();
    form.setPassword('s');
    expect(keys(form.errors.value)).toEqual({
      ...NONE,
      confirmation: 'lock.error.confirmRequired',
    });
    form.setConfirmation('s');
    expect(keys(form.errors.value)).toEqual(NONE);
  });

  it('returns the engine options when valid, and is quiet again afterwards', () => {
    const { form } = setup();
    form.submit();
    form.setPassword('secret-1');
    form.setConfirmation('secret-1');
    expect(form.submit()).toEqual({
      ok: true,
      options: {
        algorithm: 'aes-256',
        userPassword: 'secret-1',
        ownerPassword: '',
        permissions: ALL_PERMISSIONS,
        encryptMetadata: true,
      },
    });
    form.setConfirmation('');
    expect(form.errors.value.confirmation).toBeNull();
  });
});

describe('lock form: what the algorithms accept', () => {
  it('reports passwords AES-128 cannot encode, at once', () => {
    const { form } = setup();
    form.setRevealed(true);
    form.setPassword('密码123');
    expect(form.valid.value).toBe(true);
    form.setAlgorithm('aes-128');
    expect(form.errors.value.password?.key).toBe('lock.error.notEncodable.aes-128');
    expect(form.valid.value).toBe(false);
    form.setAlgorithm('aes-256');
    expect(form.errors.value.password).toBeNull();
  });

  it('enforces the 32-byte limit of AES-128 and the 127-byte limit of AES-256', () => {
    const { form } = setup();
    form.setRevealed(true);
    form.setAlgorithm('aes-128');
    form.setPassword('x'.repeat(32));
    expect(form.errors.value.password).toBeNull();
    form.setPassword('x'.repeat(33));
    expect(form.errors.value.password?.key).toBe('lock.error.tooLong.aes-128');
    form.setAlgorithm('aes-256');
    expect(form.errors.value.password).toBeNull();
    form.setPassword('密'.repeat(42));
    expect(form.errors.value.password).toBeNull();
    form.setPassword('密'.repeat(43));
    expect(form.errors.value.password?.key).toBe('lock.error.tooLong.aes-256');
  });

  it('refuses characters AES-256 prohibits', () => {
    const { form } = setup();
    form.setRevealed(true);
    form.setPassword('abc\u0007def');
    expect(form.errors.value.password?.key).toBe('lock.error.notEncodable.aes-256');
  });

  it('applies the same rules to the permissions password', () => {
    const { form } = setup();
    form.setRevealed(true);
    form.setPassword('open');
    form.setSeparateOwner(true);
    form.setAlgorithm('aes-128');
    form.setOwnerPassword('权限');
    expect(form.errors.value.ownerPassword?.key).toBe('lock.error.notEncodable.aes-128');
    form.setOwnerPassword('y'.repeat(40));
    expect(form.errors.value.ownerPassword?.key).toBe('lock.error.tooLong.aes-128');
    form.setOwnerPassword('boss');
    expect(form.valid.value).toBe(true);
  });

  it('never lets through what the engine would reject', () => {
    const { form } = setup();
    form.setRevealed(true);
    const candidates = ['', 'a', '密码', 'x'.repeat(33), 'x'.repeat(128), 'é€', '­', 'ok pass'];
    for (const algorithm of ['aes-256', 'aes-128'] as const) {
      form.setAlgorithm(algorithm);
      for (const separate of [false, true]) {
        form.setSeparateOwner(separate);
        for (const main of candidates) {
          for (const owner of separate ? candidates : ['']) {
            form.setPassword(main);
            if (separate) form.setOwnerPassword(owner);
            const result = form.submit();
            if (result.ok) {
              expect(checkNewPasswords(result.options), JSON.stringify(result.options)).toBeNull();
            }
          }
        }
      }
    }
  });
});

describe('lock form: separate permissions password', () => {
  it('makes the open password optional and explains that', () => {
    const { form } = setup();
    expect(form.passwordLabel.value.key).toBe('lock.password.label');
    expect(form.passwordHint.value).toBeNull();
    form.setSeparateOwner(true);
    expect(form.passwordLabel.value.key).toBe('lock.password.openLabel');
    expect(form.passwordHint.value?.key).toBe('lock.password.openOptional');
    form.setOwnerPassword('boss');
    expect(form.valid.value).toBe(true);
    form.setPassword('open');
    expect(form.passwordHint.value).toBeNull();
  });

  it('requires the two passwords to differ', () => {
    const { form } = setup();
    form.setRevealed(true);
    form.setPassword('same');
    form.setSeparateOwner(true);
    form.setOwnerPassword('same');
    expect(form.errors.value.ownerPassword?.key).toBe('lock.error.ownerSame');
    expect(form.submit()).toMatchObject({ ok: false, field: 'ownerPassword' });
  });

  it('compares them as they would be written, not as they were typed', () => {
    const { form } = setup();
    form.setRevealed(true);
    form.setSeparateOwner(true);
    form.setPermission('print', 'none');

    // Full-width "abc123": SASLprep makes it the open password.
    const fullWidth = String.fromCodePoint(0xff41, 0xff42, 0xff43, 0xff11, 0xff12, 0xff13);
    form.setPassword('abc123');
    form.setOwnerPassword(fullWidth);
    expect(form.problems.value.ownerPassword?.key).toBe('lock.error.ownerSame');
    expect(form.errors.value.ownerPassword?.key).toBe('lock.error.ownerSame');
    expect(form.submit()).toMatchObject({ ok: false, field: 'ownerPassword' });

    // Composed and decomposed accents, under either algorithm.
    form.setPassword(`caf${String.fromCodePoint(0xe9)}`);
    form.setOwnerPassword(`cafe${String.fromCodePoint(0x301)}`);
    expect(form.problems.value.ownerPassword?.key).toBe('lock.error.ownerSame');
    form.setAlgorithm('aes-128');
    expect(form.problems.value.ownerPassword?.key).toBe('lock.error.ownerSame');

    // AES-128 cannot write full-width letters at all: that is what it says then.
    form.setPassword('abc123');
    form.setOwnerPassword(fullWidth);
    expect(form.problems.value.ownerPassword?.key).toBe('lock.error.notEncodable.aes-128');

    form.setAlgorithm('aes-256');
    form.setOwnerPassword(`${fullWidth}4`);
    expect(form.problems.value.ownerPassword).toBeNull();
    expect(form.submit().ok).toBe(true);
  });

  it('maps the permission controls to engine permissions', () => {
    const { form } = setup();
    form.setSeparateOwner(true);
    form.setOwnerPassword('boss');
    form.setPermission('print', 'low');
    form.setPermission('extract', false);
    form.setPermission('annotate', false);
    form.setEncryptMetadata(false);
    form.setAlgorithm('aes-128');
    expect(form.toEncryptOptions()).toEqual({
      algorithm: 'aes-128',
      userPassword: '',
      ownerPassword: 'boss',
      permissions: {
        print: 'low',
        modify: true,
        extract: false,
        annotate: false,
        fillForms: false,
        assemble: true,
        accessibility: true,
      },
      encryptMetadata: false,
    });
  });

  it('ignores the permission controls while there is only one password', () => {
    const { form } = setup();
    form.setPermission('print', 'none');
    form.setPermission('modify', false);
    form.setPassword('only');
    expect(form.toEncryptOptions().permissions).toEqual(ALL_PERMISSIONS);
    expect(form.toEncryptOptions().ownerPassword).toBe('');
  });

  it('forgets the permissions password when the switch is turned off', () => {
    const { form } = setup();
    form.setSeparateOwner(true);
    form.setOwnerPassword('boss');
    form.setOwnerRevealed(true);
    form.setPermission('print', 'none');
    form.setSeparateOwner(false);
    expect(form.ownerPassword.value).toBe('');
    expect(form.ownerRevealed.value).toBe(false);
    // The choices themselves are no secret and come back with the switch.
    form.setSeparateOwner(true);
    expect(form.permissions.value.print).toBe('none');
  });
});

describe('lock form: the options as a signal', () => {
  it('follows the controls, so that the file list can react to the form', () => {
    const { form } = setup();
    const passwords: string[] = [];
    const stop = effect(() => void passwords.push(form.options.value.userPassword));
    form.setPassword('a');
    form.setPassword('ab');
    stop();
    expect(passwords).toEqual(['', 'a', 'ab']);

    form.setAlgorithm('aes-128');
    form.setSeparateOwner(true);
    form.setOwnerPassword('b');
    form.setPermission('extract', false);
    form.setEncryptMetadata(false);
    expect(form.options.value).toEqual({
      algorithm: 'aes-128',
      userPassword: 'ab',
      ownerPassword: 'b',
      permissions: { ...ALL_PERMISSIONS, extract: false },
      encryptMetadata: false,
    });
    expect(form.toEncryptOptions()).toEqual(form.options.value);
  });
});

describe('lock form: summary of the advanced options', () => {
  const keys = (form: ReturnType<typeof setup>['form']) =>
    form.advancedSummary.value.list.map((item) => item.key);

  it('names the algorithm when everything else is at its default', () => {
    const { form } = setup();
    expect(keys(form)).toEqual(['algorithm.chip.aes-256']);
    form.setAlgorithm('aes-128');
    expect(keys(form)).toEqual(['algorithm.chip.aes-128']);
  });

  it('mentions a permissions password, and restrictions once something is withheld', () => {
    const { form } = setup();
    form.setSeparateOwner(true);
    expect(keys(form)).toEqual(['algorithm.chip.aes-256', 'lock.summary.ownerPassword']);
    form.setPermission('print', 'low');
    expect(keys(form)).toEqual(['algorithm.chip.aes-256', 'lock.summary.restricted']);
    form.setPermission('print', 'full');
    form.setPermission('extract', false);
    expect(keys(form)).toEqual(['algorithm.chip.aes-256', 'lock.summary.restricted']);
  });

  it('ignores the permission controls while they have no effect', () => {
    const { form } = setup();
    form.setPermission('modify', false);
    expect(keys(form)).toEqual(['algorithm.chip.aes-256']);
  });

  it('mentions metadata that stays readable', () => {
    const { form } = setup();
    form.setEncryptMetadata(false);
    expect(keys(form)).toEqual(['algorithm.chip.aes-256', 'lock.summary.metadataClear']);
  });
});

describe('lock form: strength', () => {
  it('estimates the main password as it is typed', () => {
    const { form } = setup();
    expect(form.strength.value).toMatchObject({ empty: true, score: 0, hints: [] });
    form.setPassword('password');
    expect(form.strength.value.empty).toBe(false);
    expect(form.strength.value.score).toBe(0);
    expect(form.strength.value.label.key).toBe('strength.0');
    expect(form.strength.value.hints.map((hint) => hint.key)).toContain(
      'strength.hint.common-password',
    );
    form.setPassword('Vq7#mTz2!pLx9@Rw');
    expect(form.strength.value.score).toBe(4);
    expect(form.strength.value.label.key).toBe('strength.4');
    expect(form.strength.value.hints).toEqual([]);
  });
});

describe('lock form: generator', () => {
  it('fills, reveals and marks the password as generated', () => {
    const { form } = setup();
    const value = form.generate();
    expect(value).toHaveLength(GENERATED_PASSWORD_LENGTH);
    expect(form.password.value).toBe(value);
    expect(form.revealed.value).toBe(true);
    expect(form.generated.value).toBe(true);
    expect(form.valid.value).toBe(true);
    expect(form.strength.value.score).toBe(4);
  });

  it('keeps the form valid when the generated password is hidden again', () => {
    const { form } = setup();
    form.generate();
    form.setRevealed(false);
    expect(form.valid.value).toBe(true);
  });

  it('stops calling it generated once the user edits it', () => {
    const { form } = setup();
    const value = form.generate();
    form.setPassword(value);
    expect(form.generated.value).toBe(true);
    form.setPassword(`${value}x`);
    expect(form.generated.value).toBe(false);
  });

  it('produces passwords both algorithms accept', () => {
    const { form } = setup();
    for (const algorithm of ['aes-128', 'aes-256'] as const) {
      form.setAlgorithm(algorithm);
      for (let i = 0; i < 20; i++) {
        const value = form.generate();
        expect(new TextEncoder().encode(value).length).toBeLessThanOrEqual(32);
        expect(form.errors.value.password).toBeNull();
        expect(checkNewPasswords(form.toEncryptOptions())).toBeNull();
      }
    }
  });

  it('uses the injected randomness', () => {
    let calls = 0;
    const form = createLockForm({
      random: (array) => {
        calls++;
        crypto.getRandomValues(array);
      },
    });
    form.generate();
    expect(calls).toBeGreaterThan(0);
  });

  it('can generate the permissions password', () => {
    const { form } = setup();
    form.setSeparateOwner(true);
    const value = form.generate('ownerPassword');
    expect(form.ownerPassword.value).toBe(value);
    expect(form.ownerRevealed.value).toBe(true);
    expect(form.password.value).toBe('');
    expect(form.generated.value).toBe(false);
  });
});

describe('lock form: copy', () => {
  it('copies the password and confirms with a toast', async () => {
    const writeText = vi.fn(async () => undefined);
    const { form, toastKeys, toasts } = setup({ writeText });
    const value = form.generate();
    expect(await form.copyPassword()).toBe(true);
    expect(writeText).toHaveBeenCalledWith(value);
    expect(toastKeys()).toEqual(['toast.passwordCopied']);
    expect(toasts.toasts.value[0]!.tone).toBe('success');
  });

  it('calls the clipboard synchronously, while the click is still a user gesture', () => {
    const writeText = vi.fn(async () => undefined);
    const { form } = setup({ writeText });
    form.setPassword('secret-1');
    void form.copyPassword();
    expect(writeText).toHaveBeenCalledTimes(1);
  });

  it('copies a password that is no longer in the form', async () => {
    const writeText = vi.fn(async () => undefined);
    const { form, toastKeys } = setup({ writeText });
    form.setPassword('in-the-form');
    expect(await form.copyText('applied-earlier')).toBe(true);
    expect(writeText).toHaveBeenCalledWith('applied-earlier');
    expect(toastKeys()).toEqual(['toast.passwordCopied']);
    expect(await form.copyText('')).toBe(false);
    expect(writeText).toHaveBeenCalledTimes(1);
  });

  it('copies the permissions password on request', async () => {
    const writeText = vi.fn(async () => undefined);
    const { form } = setup({ writeText });
    form.setPassword('open');
    form.setSeparateOwner(true);
    form.setOwnerPassword('boss');
    await form.copyPassword('ownerPassword');
    expect(writeText).toHaveBeenCalledWith('boss');
  });

  it('reports a refused or missing clipboard', async () => {
    const refused = setup({
      writeText: async () => {
        throw new DOMException('denied', 'NotAllowedError');
      },
    });
    refused.form.setPassword('secret-1');
    expect(await refused.form.copyPassword()).toBe(false);
    expect(refused.toastKeys()).toEqual(['toast.copyFailed']);

    const missing = setup(null);
    missing.form.setPassword('secret-1');
    expect(await missing.form.copyPassword()).toBe(false);
    expect(missing.toastKeys()).toEqual(['toast.copyFailed']);
  });

  it('does nothing for an empty password', async () => {
    const writeText = vi.fn(async () => undefined);
    const { form, toastKeys } = setup({ writeText });
    expect(await form.copyPassword()).toBe(false);
    expect(writeText).not.toHaveBeenCalled();
    expect(toastKeys()).toEqual([]);
  });

  it('never puts the password into a toast', async () => {
    const { form, toasts } = setup({ writeText: async () => undefined });
    form.setPassword('TOP-secret-99');
    await form.copyPassword();
    expect(JSON.stringify(toasts.toasts.value)).not.toContain('TOP-secret-99');
  });
});

describe('lock form: forgetting', () => {
  function filled() {
    const context = setup();
    const { form } = context;
    form.setAlgorithm('aes-128');
    form.setSeparateOwner(true);
    form.setOwnerPassword('boss');
    form.setPermission('print', 'none');
    form.setEncryptMetadata(false);
    form.setAdvancedOpen(true);
    form.generate();
    form.submit();
    return context;
  }

  it('clearSecrets drops every password but keeps the options', () => {
    const { form } = filled();
    form.clearSecrets();
    expect([form.password.value, form.confirmation.value, form.ownerPassword.value]).toEqual([
      '',
      '',
      '',
    ]);
    expect(form.revealed.value).toBe(false);
    expect(form.generated.value).toBe(false);
    expect(keys(form.errors.value)).toEqual(NONE);
    expect(form.algorithm.value).toBe('aes-128');
    expect(form.separateOwner.value).toBe(true);
    expect(form.permissions.value.print).toBe('none');
    expect(form.advancedOpen.value).toBe(true);
  });

  it('reset returns to the initial state', () => {
    const { form } = filled();
    form.reset();
    expect(form.password.value).toBe('');
    expect(form.algorithm.value).toBe('aes-256');
    expect(form.separateOwner.value).toBe(false);
    expect(form.permissions.value.print).toBe('full');
    expect(form.encryptMetadata.value).toBe(true);
    expect(form.advancedOpen.value).toBe(false);
  });
});
