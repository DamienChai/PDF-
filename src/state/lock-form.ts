/**
 * The Lock form: the new password(s), the options behind "Advanced", live validation, and the
 * `EncryptOptions` the engine is given.
 *
 * One password by default: it opens the document and grants full access. With "separate
 * permissions password" switched on, the main password becomes the open password (and may then
 * be left empty: the document opens for everybody, restricted) and a second password guards the
 * permissions.
 */
import { computed, signal, type ReadonlySignal } from '@preact/signals';
import { checkNewPasswords, sameNewPassword } from '../engine/passwords';
import { ALL_PERMISSIONS, type EncryptOptions, type PrintPermission } from '../engine/types';
import {
  algorithmChipLabel,
  strengthHintText,
  strengthLabel,
  type Message,
  type MessageKey,
  type MessageList,
} from '../i18n';
import { generatePassword, type RandomSource } from '../lib/password-generator';
import { estimateStrength, type StrengthScore } from '../lib/password-strength';
import { toasts as appToasts, type ToastQueue } from './toasts';

export type LockAlgorithm = EncryptOptions['algorithm'];

/** The permission controls of the form. Accessibility is always allowed and has no control. */
export interface LockPermissions {
  print: PrintPermission;
  /** Copying text and images. */
  extract: boolean;
  /** Changing the content. */
  modify: boolean;
  /** Commenting and filling in forms (one control for both). */
  annotate: boolean;
  /** Inserting, deleting and rotating pages. */
  assemble: boolean;
}

export type LockField = 'password' | 'confirmation' | 'ownerPassword';

export type LockFormErrors = Readonly<Record<LockField, Message | null>>;

export interface StrengthView {
  /** Nothing typed yet: show no meter. */
  empty: boolean;
  /** 0 = very weak … 4 = very strong. */
  score: StrengthScore;
  /** Estimated entropy in bits. */
  bits: number;
  label: Message;
  /** What would make the password stronger; empty for a good one. */
  hints: Message[];
}

export type LockSubmitResult =
  | { ok: true; options: EncryptOptions }
  /** `field` is the first invalid field, for moving the focus there. */
  | { ok: false; field: LockField; errors: LockFormErrors };

export interface LockForm {
  // --- values ---
  readonly password: ReadonlySignal<string>;
  readonly confirmation: ReadonlySignal<string>;
  /** The main password is shown in clear text; no confirmation is needed while it is. */
  readonly revealed: ReadonlySignal<boolean>;
  readonly algorithm: ReadonlySignal<LockAlgorithm>;
  readonly separateOwner: ReadonlySignal<boolean>;
  readonly ownerPassword: ReadonlySignal<string>;
  readonly ownerRevealed: ReadonlySignal<boolean>;
  readonly permissions: ReadonlySignal<LockPermissions>;
  readonly encryptMetadata: ReadonlySignal<boolean>;
  /** Whether the "Advanced options" section is expanded. */
  readonly advancedOpen: ReadonlySignal<boolean>;

  // --- derived ---
  /** Show the confirmation field. */
  readonly confirmationNeeded: ReadonlySignal<boolean>;
  /**
   * What Enter does in the main password field: `next` moves on to the confirmation, which is
   * still to be typed; `go` submits.
   */
  readonly passwordEnter: ReadonlySignal<'next' | 'go'>;
  /** The main password came from the generator and was not edited since: offer "copy". */
  readonly generated: ReadonlySignal<boolean>;
  readonly strength: ReadonlySignal<StrengthView>;
  /** "Password", or "Open password" while a separate permissions password is used. */
  readonly passwordLabel: ReadonlySignal<Message>;
  /** Shown under the main password while it may be left empty. */
  readonly passwordHint: ReadonlySignal<Message | null>;
  /**
   * What the advanced options amount to, for the collapsed section: the algorithm, then whatever
   * differs from the defaults ("AES-256 · Restricted").
   */
  readonly advancedSummary: ReadonlySignal<MessageList>;
  /** Everything that is wrong right now, whether or not it should be shown yet. */
  readonly problems: ReadonlySignal<LockFormErrors>;
  /** What to show next to each field at this moment. */
  readonly errors: ReadonlySignal<LockFormErrors>;
  /** No problems: `submit()` would succeed. */
  readonly valid: ReadonlySignal<boolean>;
  /** The current values as engine options, valid or not. */
  readonly options: ReadonlySignal<EncryptOptions>;

  // --- editing ---
  setPassword(value: string): void;
  setConfirmation(value: string): void;
  setRevealed(revealed: boolean): void;
  setAlgorithm(algorithm: LockAlgorithm): void;
  setSeparateOwner(enabled: boolean): void;
  setOwnerPassword(value: string): void;
  setOwnerRevealed(revealed: boolean): void;
  setPermission<K extends keyof LockPermissions>(key: K, value: LockPermissions[K]): void;
  setEncryptMetadata(enabled: boolean): void;
  setAdvancedOpen(open: boolean): void;
  /** The user left the field: from now on it may show "does not match". */
  touch(field: LockField): void;

  // --- actions ---
  /** Fills in a strong random password, shows it, and returns it. */
  generate(field?: 'password' | 'ownerPassword'): string;
  /**
   * Copies a password to the clipboard and reports the outcome with a toast. Call it directly
   * from a click handler.
   */
  copyPassword(field?: 'password' | 'ownerPassword'): Promise<boolean>;
  /** The same for a password that is not (or no longer) in the form. */
  copyText(value: string): Promise<boolean>;
  /** Validates. On failure every problem becomes visible until it is fixed. */
  submit(): LockSubmitResult;
  /** `options` at this moment, without validating. */
  toEncryptOptions(): EncryptOptions;
  /** Forgets every password; keeps algorithm, permissions and switches. */
  clearSecrets(): void;
  /** Back to the initial state. */
  reset(): void;
}

export interface LockFormEnvironment {
  toasts?: ToastQueue;
  /** `navigator.clipboard`, looked up at the moment of copying. */
  clipboard?: () => Pick<Clipboard, 'writeText'> | undefined;
  /** Randomness for the generator; the system source by default. */
  random?: RandomSource;
}

/** Length of generated passwords: about 120 bits, and well inside the 32 bytes of AES-128. */
export const GENERATED_PASSWORD_LENGTH = 20;

const MAX_PASSWORD_BYTES: Readonly<Record<LockAlgorithm, number>> = {
  'aes-256': 127,
  'aes-128': 32,
};

const DEFAULT_PERMISSIONS: Readonly<LockPermissions> = Object.freeze({
  print: 'full',
  extract: true,
  modify: true,
  annotate: true,
  assemble: true,
});

const FIELD_ORDER: readonly LockField[] = ['password', 'confirmation', 'ownerPassword'];

function browserClipboard(): Pick<Clipboard, 'writeText'> | undefined {
  return typeof navigator === 'undefined' ? undefined : navigator.clipboard;
}

/**
 * What a set of options amounts to, for a single line: the algorithm, then whatever differs from
 * the defaults ("AES-256 · Restricted"). `separateOwner` says whether a permissions password of
 * its own is in use; in submitted options that is the case exactly when there is one.
 */
export function lockSettingsSummary(
  options: EncryptOptions,
  separateOwner: boolean = options.ownerPassword !== '',
): MessageList {
  const list: Message[] = [
    algorithmChipLabel({
      algorithm: options.algorithm,
      keyBits: options.algorithm === 'aes-256' ? 256 : 128,
    }),
  ];
  if (separateOwner) {
    const allowed = options.permissions;
    const restricted =
      allowed.print !== 'full' ||
      !allowed.extract ||
      !allowed.modify ||
      !allowed.annotate ||
      !allowed.assemble;
    list.push({ key: restricted ? 'lock.summary.restricted' : 'lock.summary.ownerPassword' });
  }
  if (!options.encryptMetadata) list.push({ key: 'lock.summary.metadataClear' });
  return { list };
}

/** The engine's verdict on one new password, as a message; null if it can be used. */
function encodingProblem(password: string, algorithm: LockAlgorithm): Message | null {
  if (password === '') return null;
  // Checked alone, as the user password: the engine applies the same rule to both passwords.
  const problem = checkNewPasswords({ algorithm, userPassword: password, ownerPassword: '' });
  if (problem === 'password-too-long') {
    const key: MessageKey = `lock.error.tooLong.${algorithm}`;
    return { key };
  }
  if (problem === 'password-not-encodable') {
    const key: MessageKey = `lock.error.notEncodable.${algorithm}`;
    return { key };
  }
  return null;
}

export function createLockForm(env: LockFormEnvironment = {}): LockForm {
  const toasts = env.toasts ?? appToasts;

  const password = signal('');
  const confirmation = signal('');
  const revealed = signal(false);
  const generated = signal(false);
  const algorithm = signal<LockAlgorithm>('aes-256');
  const separateOwner = signal(false);
  const ownerPassword = signal('');
  const ownerRevealed = signal(false);
  const permissions = signal<LockPermissions>({ ...DEFAULT_PERMISSIONS });
  const encryptMetadata = signal(true);
  const advancedOpen = signal(false);
  /** A submit attempt failed: every problem is shown until the form is valid again. */
  const submitted = signal(false);
  const touched = signal<ReadonlySet<LockField>>(new Set());

  const confirmationNeeded = computed(() => !revealed.value);
  const passwordEnter = computed<'next' | 'go'>(() =>
    confirmationNeeded.value && confirmation.value === '' ? 'next' : 'go',
  );

  const strength = computed<StrengthView>(() => {
    const estimate = estimateStrength(password.value);
    return {
      empty: password.value === '',
      score: estimate.score,
      bits: estimate.bits,
      label: strengthLabel(estimate.score),
      hints: estimate.hints.map(strengthHintText),
    };
  });

  const problems = computed<LockFormErrors>(() => {
    const main = password.value;
    const owner = ownerPassword.value;

    let passwordProblem: Message | null = encodingProblem(main, algorithm.value);
    if (main === '' && !separateOwner.value) passwordProblem = { key: 'lock.error.required' };

    let confirmationProblem: Message | null = null;
    if (confirmationNeeded.value && main !== '') {
      if (confirmation.value === '') confirmationProblem = { key: 'lock.error.confirmRequired' };
      else if (confirmation.value !== main) confirmationProblem = { key: 'lock.error.mismatch' };
    }

    let ownerProblem: Message | null = null;
    if (separateOwner.value) {
      if (owner === '') ownerProblem = { key: 'lock.error.ownerRequired' };
      // Compared as the engine would write them: text that looks different can be one password
      // (full-width and ordinary digits under AES-256), and the restrictions would guard nothing.
      else if (sameNewPassword(owner, main, algorithm.value)) {
        ownerProblem = { key: 'lock.error.ownerSame' };
      } else ownerProblem = encodingProblem(owner, algorithm.value);
    }

    return {
      password: passwordProblem,
      confirmation: confirmationProblem,
      ownerPassword: ownerProblem,
    };
  });

  const valid = computed(() => FIELD_ORDER.every((field) => problems.value[field] === null));

  const errors = computed<LockFormErrors>(() => {
    const all = problems.value;
    if (submitted.value) return all;
    // Before a submit attempt, only what the user cannot be about to fix by typing on:
    // "required" waits for the attempt, a mismatch for a wrong character or leaving the field.
    const isMissing = (problem: Message | null): boolean =>
      problem?.key === 'lock.error.required' ||
      problem?.key === 'lock.error.confirmRequired' ||
      problem?.key === 'lock.error.ownerRequired';
    const stillTyping =
      !touched.value.has('confirmation') && password.value.startsWith(confirmation.value);
    return {
      password: isMissing(all.password) ? null : all.password,
      confirmation: isMissing(all.confirmation) || stillTyping ? null : all.confirmation,
      ownerPassword: isMissing(all.ownerPassword) ? null : all.ownerPassword,
    };
  });

  const passwordLabel = computed<Message>(() => ({
    key: separateOwner.value ? 'lock.password.openLabel' : 'lock.password.label',
  }));
  const passwordHint = computed<Message | null>(() =>
    separateOwner.value && password.value === '' ? { key: 'lock.password.openOptional' } : null,
  );

  const options = computed<EncryptOptions>(() => {
    const chosen = permissions.value;
    const separate = separateOwner.value;
    return {
      algorithm: algorithm.value,
      userPassword: password.value,
      // '' tells the engine to use the one password for both roles.
      ownerPassword: separate ? ownerPassword.value : '',
      // Restrictions need a second password to mean anything: whoever has the only password
      // has full access anyway.
      permissions: separate
        ? {
            print: chosen.print,
            modify: chosen.modify,
            extract: chosen.extract,
            annotate: chosen.annotate,
            fillForms: chosen.annotate,
            assemble: chosen.assemble,
            accessibility: true,
          }
        : { ...ALL_PERMISSIONS },
      encryptMetadata: encryptMetadata.value,
    };
  });

  const advancedSummary = computed<MessageList>(() =>
    lockSettingsSummary(options.value, separateOwner.value),
  );

  function untouch(field: LockField): void {
    if (!touched.peek().has(field)) return;
    const next = new Set(touched.peek());
    next.delete(field);
    touched.value = next;
  }

  function clearSecrets(): void {
    password.value = '';
    confirmation.value = '';
    ownerPassword.value = '';
    revealed.value = false;
    ownerRevealed.value = false;
    generated.value = false;
    submitted.value = false;
    touched.value = new Set();
  }

  function toEncryptOptions(): EncryptOptions {
    return options.peek();
  }

  async function copyText(value: string): Promise<boolean> {
    if (value === '') return false;
    try {
      const clipboard = (env.clipboard ?? browserClipboard)();
      if (!clipboard) throw new Error('clipboard unavailable');
      // Called before the first await: the clipboard needs the user activation of the click.
      await clipboard.writeText(value);
      toasts.show({ key: 'toast.passwordCopied' }, { tone: 'success' });
      return true;
    } catch {
      toasts.show({ key: 'toast.copyFailed' }, { tone: 'error' });
      return false;
    }
  }

  return {
    password,
    confirmation,
    revealed,
    algorithm,
    separateOwner,
    ownerPassword,
    ownerRevealed,
    permissions,
    encryptMetadata,
    advancedOpen,
    confirmationNeeded,
    passwordEnter,
    generated,
    strength,
    passwordLabel,
    passwordHint,
    advancedSummary,
    problems,
    errors,
    valid,
    options,

    setPassword(value) {
      if (value === password.peek()) return;
      password.value = value;
      generated.value = false;
    },
    setConfirmation(value) {
      confirmation.value = value;
      // Typing again is a new attempt: wait until it is finished before judging it.
      untouch('confirmation');
    },
    setRevealed(next) {
      revealed.value = next;
    },
    setAlgorithm(next) {
      algorithm.value = next;
    },
    setSeparateOwner(enabled) {
      separateOwner.value = enabled;
      if (!enabled) {
        // Not used any more, so not kept either.
        ownerPassword.value = '';
        ownerRevealed.value = false;
      }
    },
    setOwnerPassword(value) {
      ownerPassword.value = value;
    },
    setOwnerRevealed(next) {
      ownerRevealed.value = next;
    },
    setPermission(key, value) {
      permissions.value = { ...permissions.peek(), [key]: value };
    },
    setEncryptMetadata(enabled) {
      encryptMetadata.value = enabled;
    },
    setAdvancedOpen(open) {
      advancedOpen.value = open;
    },
    touch(field) {
      if (touched.peek().has(field)) return;
      touched.value = new Set(touched.peek()).add(field);
    },

    generate(field = 'password') {
      const length = Math.min(GENERATED_PASSWORD_LENGTH, MAX_PASSWORD_BYTES[algorithm.peek()]);
      const value = generatePassword({ length }, env.random);
      if (field === 'ownerPassword') {
        ownerPassword.value = value;
        ownerRevealed.value = true;
        return value;
      }
      password.value = value;
      // Nobody retypes twenty random characters: hiding the password again must not ask for it.
      confirmation.value = value;
      revealed.value = true;
      generated.value = true;
      return value;
    },

    copyPassword(field = 'password') {
      return copyText(field === 'ownerPassword' ? ownerPassword.peek() : password.peek());
    },
    copyText,

    submit() {
      const current = problems.peek();
      const field = FIELD_ORDER.find((candidate) => current[candidate] !== null);
      if (field) {
        submitted.value = true;
        return { ok: false, field, errors: current };
      }
      submitted.value = false;
      return { ok: true, options: toEncryptOptions() };
    },

    toEncryptOptions,
    clearSecrets,
    reset() {
      clearSecrets();
      algorithm.value = 'aes-256';
      separateOwner.value = false;
      permissions.value = { ...DEFAULT_PERMISSIONS };
      encryptMetadata.value = true;
      advancedOpen.value = false;
    },
  };
}

/** The app's Lock form. */
export const lockForm: LockForm = createLockForm();
